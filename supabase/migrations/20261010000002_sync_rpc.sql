-- One round trip: send what changed here, receive what changed there.
--
-- Push and pull in a single function for two reasons. A sale and its lines,
-- its stock movements and its ledger entry have to land together or not at
-- all, which PostgREST cannot do across tables. And on a bad connection one
-- request succeeds far more often than eight.
--
-- The conflict rules live here rather than in the app because the app on the
-- shop counter cannot be force-updated. Whatever is running out there, the
-- server decides.

-- ---------------------------------------------------------------------------
-- Everything the client may pull, as one ordered stream
-- ---------------------------------------------------------------------------

create or replace view sync_feed as
  select 'settings'::text as table_name, key as id, server_seq, to_jsonb(t) as data from settings t
  union all select 'users', id, server_seq, to_jsonb(t) from users t
  union all select 'categories', id, server_seq, to_jsonb(t) from categories t
  union all select 'items', id, server_seq, to_jsonb(t) from items t
  union all select 'customers', id, server_seq, to_jsonb(t) from customers t
  union all select 'sales', id, server_seq, to_jsonb(t) from sales t
  union all select 'sale_items', id, server_seq, to_jsonb(t) from sale_items t
  union all select 'sale_returns', id, server_seq, to_jsonb(t) from sale_returns t
  union all select 'sale_return_items', id, server_seq, to_jsonb(t) from sale_return_items t
  union all select 'stock_movements', id, server_seq, to_jsonb(t) from stock_movements t
  union all select 'customer_ledger_entries', id, server_seq, to_jsonb(t) from customer_ledger_entries t
  union all select 'customer_payments', id, server_seq, to_jsonb(t) from customer_payments t
  union all select 'expenses', id, server_seq, to_jsonb(t) from expenses t
  union all select 'audit_log', id, server_seq, to_jsonb(t) from audit_log t;

-- ---------------------------------------------------------------------------
-- Which rules apply to which table
-- ---------------------------------------------------------------------------

create or replace function sync_table_kind(t text) returns text
language sql immutable as $$
  select case t
    when 'settings' then 'master'
    when 'users' then 'master'
    when 'categories' then 'master'
    when 'items' then 'master'
    when 'customers' then 'master'
    when 'expenses' then 'master'
    -- A bill only ever changes by being voided, which flips `status`.
    when 'sales' then 'master'
    when 'sale_items' then 'event'
    when 'sale_returns' then 'event'
    when 'sale_return_items' then 'event'
    when 'stock_movements' then 'event'
    when 'customer_ledger_entries' then 'event'
    when 'customer_payments' then 'event'
    when 'audit_log' then 'event'
    else null
  end;
$$;

/* How far ahead of us a client's clock may be before we stop believing it. */
create or replace function sync_max_skew() returns interval
language sql immutable as $$ select interval '5 minutes' $$;

-- ---------------------------------------------------------------------------
-- The exchange
-- ---------------------------------------------------------------------------

create or replace function sync_v1(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device      text := payload ->> 'deviceId';
  v_cursor      bigint := coalesce((payload ->> 'cursor')::bigint, 0);
  v_limit       int := least(coalesce((payload ->> 'pullLimit')::int, 500), 1000);
  v_now         timestamptz := now();
  v_change      jsonb;
  v_table       text;
  v_id          text;
  v_kind        text;
  v_deleted     boolean;
  v_incoming    timestamptz;
  v_effective   timestamptz;
  v_existing    timestamptz;
  v_data        jsonb;
  v_cols        text;
  v_results     jsonb := '[]'::jsonb;
  v_written     text[] := array[]::text[];
  v_changes     jsonb;
  v_next_cursor bigint;
  v_has_more    boolean;
begin
  -- Membership is the whole access check. `security definer` means this runs
  -- with rights the caller does not have, so it must prove who they are first.
  if not is_shop_member() then
    raise exception 'not a member of this shop' using errcode = '42501';
  end if;

  if v_device is null or length(v_device) = 0 then
    raise exception 'deviceId is required' using errcode = '22023';
  end if;

  -- ----- what the client sent -----------------------------------------
  for v_change in select * from jsonb_array_elements(coalesce(payload -> 'changes', '[]'::jsonb))
  loop
    v_table   := v_change ->> 'table';
    v_id      := v_change ->> 'id';
    v_kind    := sync_table_kind(v_table);
    v_deleted := coalesce((v_change ->> 'deleted')::boolean, false);
    v_data    := coalesce(v_change -> 'data', '{}'::jsonb);

    if v_kind is null then
      v_results := v_results || jsonb_build_object(
        'table', v_table, 'id', v_id, 'status', 'rejected',
        'reason', format('%s is not a table this shop syncs.', v_table));
      continue;
    end if;

    -- A row deleted outright locally becomes a tombstone here, so other
    -- devices learn it is gone rather than quietly keeping it forever.
    if v_deleted then
      execute format(
        'update %I set deleted_at = coalesce(deleted_at, $1) where %I = $2',
        v_table, case when v_table = 'settings' then 'key' else 'id' end)
        using to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), v_id;

      v_results := v_results || jsonb_build_object('table', v_table, 'id', v_id, 'status', 'ok');
      v_written := v_written || (v_table || ':' || v_id);
      continue;
    end if;

    -- Column list for the upsert, server_seq excluded because the trigger
    -- owns it.
    select string_agg(format('%I = excluded.%I', column_name, column_name), ', ')
      into v_cols
      from information_schema.columns
     where table_schema = 'public' and table_name = v_table
       and column_name not in ('server_seq');

    if v_kind = 'event' then
      -- Written once, never changed, so seeing it twice is an ordinary retry
      -- rather than a problem. Nothing to compare, nothing to conflict over.
      execute format(
        'insert into %I select * from jsonb_populate_record(null::%I, $1)
         on conflict (%I) do nothing',
        v_table, v_table, case when v_table = 'settings' then 'key' else 'id' end)
        using v_data;

      v_results := v_results || jsonb_build_object('table', v_table, 'id', v_id, 'status', 'ok');
      v_written := v_written || (v_table || ':' || v_id);
      continue;
    end if;

    -- ----- master rows: last write wins, on a clock we trust ------------
    begin
      v_incoming := (v_change ->> 'updatedAt')::timestamptz;
    exception when others then
      v_incoming := null;
    end;

    if v_incoming is null then
      v_results := v_results || jsonb_build_object(
        'table', v_table, 'id', v_id, 'status', 'rejected',
        'reason', 'That change arrived without a usable timestamp.');
      continue;
    end if;

    if v_incoming > v_now + sync_max_skew() then
      v_results := v_results || jsonb_build_object(
        'table', v_table, 'id', v_id, 'status', 'rejected',
        'reason', 'That computer''s clock is set far ahead. Correct the date and time, then try again.');
      continue;
    end if;

    -- Clamped to our own clock before comparing. A counter PC running days
    -- fast would otherwise win every conflict forever, and nobody would
    -- understand why the website's changes kept disappearing.
    v_effective := least(v_incoming, v_now);

    execute format(
      'select updated_at::timestamptz from %I where %I = $1',
      v_table, case when v_table = 'settings' then 'key' else 'id' end)
      into v_existing using v_id;

    if v_existing is not null and v_effective <= v_existing then
      v_results := v_results || jsonb_build_object(
        'table', v_table, 'id', v_id, 'status', 'conflict',
        'reason', 'This was changed somewhere else more recently, so that change was kept.');
      continue;
    end if;

    execute format(
      'insert into %I select * from jsonb_populate_record(null::%I, $1)
       on conflict (%I) do update set %s',
      v_table, v_table,
      case when v_table = 'settings' then 'key' else 'id' end,
      v_cols)
      using v_data;

    v_results := v_results || jsonb_build_object('table', v_table, 'id', v_id, 'status', 'ok');
    v_written := v_written || (v_table || ':' || v_id);
  end loop;

  -- ----- what the client has not seen ----------------------------------
  -- Rows written a moment ago by this very request are skipped: the client
  -- already has them, and sending them straight back doubles the traffic for
  -- nothing.
  select coalesce(jsonb_agg(row_to_json(f)::jsonb order by f.server_seq), '[]'::jsonb)
    into v_changes
    from (
      select table_name, id, server_seq, data,
             (data ->> 'deleted_at') is not null as deleted
        from sync_feed
       where server_seq > v_cursor
         and not ((table_name || ':' || id) = any (v_written))
       order by server_seq
       limit v_limit
    ) f;

  select coalesce(max((c ->> 'server_seq')::bigint), v_cursor)
    into v_next_cursor
    from jsonb_array_elements(v_changes) c;

  select exists (
    select 1 from sync_feed
     where server_seq > v_next_cursor
       and not ((table_name || ':' || id) = any (v_written))
  ) into v_has_more;

  return jsonb_build_object(
    'serverTime', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'results', v_results,
    'changes', v_changes,
    'cursor', v_next_cursor,
    'hasMore', v_has_more
  );
end;
$$;

revoke all on function sync_v1(jsonb) from public, anon;
grant execute on function sync_v1(jsonb) to authenticated;
