-- Name the offending row in the error, so one bad row cannot stall the queue.
--
-- A row the database refuses outright -- a check constraint, a type that will
-- not cast -- aborts the whole request, which is deliberate: a bill and its
-- lines must land together or not at all, so the request is one transaction.
--
-- But the counter PC then has a batch that fails every time it is retried, and
-- no way to tell which of the hundred rows is the problem. Everything queued
-- behind it would eventually be marked dead along with it.
--
-- So the error carries `hint = '<table>:<id>'`. PostgREST passes `hint`
-- through to the client, which sets that one row aside and sends the rest.
-- After repeated failures the bad row alone is marked dead and shown on the
-- diagnostics screen.

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
  v_pk          text;
  v_kind        text;
  v_deleted     boolean;
  v_exists      boolean;
  v_incoming    timestamptz;
  v_effective   timestamptz;
  v_existing    timestamptz;
  v_data        jsonb;
  v_cols        text;
  v_sets        text;
  v_results     jsonb := '[]'::jsonb;
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
    v_pk      := case when v_table = 'settings' then 'key' else 'id' end;

    if v_kind is null then
      v_results := v_results || jsonb_build_object(
        'table', v_table, 'id', v_id, 'status', 'rejected',
        'reason', format('%s is not a table this shop syncs.', v_table));
      continue;
    end if;

    if v_id is null or length(v_id) = 0 then
      v_results := v_results || jsonb_build_object(
        'table', v_table, 'id', v_id, 'status', 'rejected',
        'reason', 'That change arrived without a row identifier.');
      continue;
    end if;

    -- A row deleted outright locally becomes a tombstone here, so other
    -- devices learn it is gone rather than quietly keeping it forever.
    if v_deleted then
      execute format(
        'update %I set deleted_at = coalesce(deleted_at, $1) where %I = $2', v_table, v_pk)
        using to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), v_id;

      v_results := v_results || jsonb_build_object('table', v_table, 'id', v_id, 'status', 'ok');
      continue;
    end if;

    -- The identifier and the row must agree, or the result would report a
    -- different row from the one written.
    if coalesce(v_data ->> v_pk, '') <> v_id then
      v_results := v_results || jsonb_build_object(
        'table', v_table, 'id', v_id, 'status', 'rejected',
        'reason', 'That change does not match the row it claims to be.');
      continue;
    end if;

    -- Exactly the columns this table has and this payload carries. Anything
    -- the client does not know about keeps its default or its current value;
    -- anything the client sends that this table does not have is ignored.
    -- `server_seq` is excluded because the trigger owns it.
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position),
           string_agg(
             format('%I = excluded.%I', column_name, column_name), ', ' order by ordinal_position)
             filter (where column_name <> v_pk)
      into v_cols, v_sets
      from information_schema.columns
     where table_schema = 'public'
       and table_name = v_table
       and column_name <> 'server_seq'
       and v_data ? column_name;

    if v_cols is null then
      v_results := v_results || jsonb_build_object(
        'table', v_table, 'id', v_id, 'status', 'rejected',
        'reason', 'That change carried no columns this shop recognises.');
      continue;
    end if;

    execute format('select exists (select 1 from %I where %I = $1)', v_table, v_pk)
      into v_exists using v_id;

    if v_kind = 'event' then
      -- Written once, never changed, so seeing it twice is an ordinary retry
      -- rather than a problem. Nothing to compare, nothing to conflict over.
      if not v_exists then
        begin
          execute format(
            'insert into %I (%s) select %s from jsonb_populate_record(null::%I, $1)
             on conflict (%I) do nothing',
            v_table, v_cols, v_cols, v_table, v_pk)
            using v_data;
        exception when others then
          raise exception 'Could not save % %: %', v_table, v_id, sqlerrm
            using errcode = '22023', hint = v_table || ':' || v_id;
        end;
      end if;

      v_results := v_results || jsonb_build_object('table', v_table, 'id', v_id, 'status', 'ok');
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

    if v_exists then
      execute format('select updated_at::timestamptz from %I where %I = $1', v_table, v_pk)
        into v_existing using v_id;

      if v_existing is not null and v_effective <= v_existing then
        v_results := v_results || jsonb_build_object(
          'table', v_table, 'id', v_id, 'status', 'conflict',
          'reason', 'This was changed somewhere else more recently, so that change was kept.');
        continue;
      end if;

      if v_sets is not null then
        begin
          -- Only the columns that were sent. A NOT NULL column the payload
          -- never mentioned keeps the value it already has.
          execute format(
            'update %I set %s from jsonb_populate_record(null::%I, $1) as excluded
              where %I.%I = $2',
            v_table, v_sets, v_table, v_table, v_pk)
            using v_data, v_id;
        exception when others then
          raise exception 'Could not save % %: %', v_table, v_id, sqlerrm
            using errcode = '22023', hint = v_table || ':' || v_id;
        end;
      end if;
    else
      begin
        -- A new row has to be complete. If it is not, the error names the
        -- column that was missing.
        execute format(
          'insert into %I (%s) select %s from jsonb_populate_record(null::%I, $1)
           on conflict (%I) do nothing',
          v_table, v_cols, v_cols, v_table, v_pk)
          using v_data;
      exception when others then
        raise exception 'Could not save % %: %', v_table, v_id, sqlerrm
          using errcode = '22023', hint = v_table || ':' || v_id;
      end;
    end if;

    v_results := v_results || jsonb_build_object('table', v_table, 'id', v_id, 'status', 'ok');
  end loop;

  -- ----- what the client has not seen ----------------------------------
  select coalesce(jsonb_agg(row_to_json(f)::jsonb order by f.server_seq), '[]'::jsonb)
    into v_changes
    from (
      select table_name, id, server_seq, data,
             (data ->> 'deleted_at') is not null as deleted
        from sync_feed
       where server_seq > v_cursor
       order by server_seq
       limit v_limit
    ) f;

  select coalesce(max((c ->> 'server_seq')::bigint), v_cursor)
    into v_next_cursor
    from jsonb_array_elements(v_changes) c;

  select exists (select 1 from sync_feed where server_seq > v_next_cursor)
    into v_has_more;

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
