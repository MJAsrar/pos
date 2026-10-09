-- The shop's cloud copy.
--
-- Mirrors the SQLite schema the counter PC runs, with three differences that
-- matter:
--
--   1. No qty_on_hand, and no customer balance. Those are running sums of
--      stock_movements and the ledger. Storing an absolute figure here would
--      mean a stale number could travel back and wipe out a day of offline
--      sales. Views compute them instead, so they are always right by
--      construction.
--
--   2. Every row carries server_seq, stamped from one global sequence. That is
--      what the counter PC's pull cursor follows. A monotonic counter rather
--      than a timestamp, because a row committed with an older timestamp than
--      the watermark already passed would be skipped forever.
--
--   3. Timestamps are stored as the exact text the client sent. Converting to
--      timestamptz and back would reformat them, and every row would look
--      changed on the next round trip.

-- ---------------------------------------------------------------------------
-- Who may see this shop
-- ---------------------------------------------------------------------------

-- Membership is explicit. Public sign-up is enabled on this project by
-- default, so "any authenticated user" would mean anybody who registers an
-- account. Being in this table is a deliberate act.
create table if not exists shop_members (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  label      text not null,
  added_at   timestamptz not null default now()
);

alter table shop_members enable row level security;

create policy "members can see the member list"
  on shop_members for select
  using (exists (select 1 from shop_members m where m.user_id = auth.uid()));

create or replace function is_shop_member() returns boolean
language sql stable security definer set search_path = public, auth as $$
  select exists (select 1 from shop_members where user_id = auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- The cursor every pull follows
-- ---------------------------------------------------------------------------

create sequence if not exists global_seq;

create or replace function stamp_server_seq() returns trigger
language plpgsql as $$
begin
  new.server_seq := nextval('global_seq');
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists settings (
  key         text primary key,
  value       text not null,
  updated_at  text not null,
  server_seq  bigint
);

create table if not exists users (
  id               text primary key,
  username         text not null,
  full_name        text not null,
  pin_hash         text not null,
  role             text not null,
  permissions_json text not null default '[]',
  is_active        integer not null default 1,
  failed_attempts  integer not null default 0,
  locked_until     text,
  last_login_at    text,
  created_at       text not null,
  updated_at       text not null,
  deleted_at       text,
  server_seq       bigint
);

create table if not exists categories (
  id          text primary key,
  name        text not null,
  sort_order  integer not null default 0,
  created_at  text not null,
  updated_at  text not null,
  deleted_at  text,
  server_seq  bigint
);

-- No qty_on_hand: see the note at the top of this file.
create table if not exists items (
  id               text primary key,
  code             text not null,
  name             text not null,
  category_id      text,
  unit             text not null default 'pcs',
  cost_price       bigint not null default 0,
  sale_price       bigint not null default 0,
  min_price        bigint,
  low_stock_level  double precision not null default 0,
  photo_path       text,
  is_active        integer not null default 1,
  created_at       text not null,
  updated_at       text not null,
  deleted_at       text,
  server_seq       bigint
);

-- No balance: see the note at the top of this file.
create table if not exists customers (
  id               text primary key,
  name             text not null,
  phone            text,
  address          text,
  opening_balance  bigint not null default 0,
  notes            text,
  is_active        integer not null default 1,
  created_at       text not null,
  updated_at       text not null,
  deleted_at       text,
  server_seq       bigint
);

create table if not exists sales (
  id              text primary key,
  invoice_no      text not null,
  customer_id     text,
  user_id         text not null,
  sold_at         text not null,
  subtotal        bigint not null,
  discount        bigint not null default 0,
  rounding        bigint not null default 0,
  total           bigint not null,
  paid            bigint not null default 0,
  payment_method  text not null,
  cost_total      bigint not null default 0,
  status          text not null default 'active',
  note            text,
  created_at      text not null,
  updated_at      text not null,
  deleted_at      text,
  server_seq      bigint
);

create table if not exists sale_items (
  id          text primary key,
  sale_id     text not null,
  item_id     text not null,
  item_code   text not null,
  item_name   text not null,
  unit        text not null default 'pcs',
  qty         double precision not null,
  unit_price  bigint not null,
  cost_price  bigint not null,
  line_total  bigint not null,
  line_no     integer not null,
  server_seq  bigint
);

create table if not exists sale_returns (
  id             text primary key,
  return_no      text not null,
  sale_id        text not null,
  customer_id    text,
  user_id        text not null,
  returned_at    text not null,
  total          bigint not null,
  cost_total     bigint not null default 0,
  refund_method  text not null,
  reason         text,
  created_at     text not null,
  updated_at     text not null,
  deleted_at     text,
  server_seq     bigint
);

create table if not exists sale_return_items (
  id            text primary key,
  return_id     text not null,
  sale_item_id  text not null,
  item_id       text not null,
  item_name     text not null,
  qty           double precision not null,
  unit_price    bigint not null,
  cost_price    bigint not null,
  line_total    bigint not null,
  server_seq    bigint
);

-- The signed deltas that stock is actually made of.
create table if not exists stock_movements (
  id             text primary key,
  item_id        text not null,
  type           text not null,
  qty_delta      double precision not null,
  qty_after      double precision not null,
  unit_cost      bigint,
  supplier_name  text,
  reason         text,
  ref_type       text,
  ref_id         text,
  user_id        text not null,
  created_at     text not null,
  updated_at     text not null,
  deleted_at     text,
  server_seq     bigint
);

create table if not exists customer_ledger_entries (
  id             text primary key,
  customer_id    text not null,
  type           text not null,
  amount         bigint not null,
  balance_after  bigint not null,
  ref_type       text,
  ref_id         text,
  ref_label      text,
  note           text,
  user_id        text not null,
  entry_date     text not null,
  created_at     text not null,
  updated_at     text not null,
  deleted_at     text,
  server_seq     bigint
);

create table if not exists customer_payments (
  id           text primary key,
  customer_id  text not null,
  amount       bigint not null,
  method       text not null,
  received_at  text not null,
  user_id      text not null,
  note         text,
  created_at   text not null,
  updated_at   text not null,
  deleted_at   text,
  server_seq   bigint
);

create table if not exists expenses (
  id           text primary key,
  category     text not null,
  description  text,
  amount       bigint not null,
  spent_at     text not null,
  user_id      text not null,
  created_at   text not null,
  updated_at   text not null,
  deleted_at   text,
  server_seq   bigint
);

create table if not exists audit_log (
  id           text primary key,
  user_id      text not null,
  action       text not null,
  entity       text not null,
  entity_id    text not null,
  summary      text not null,
  before_json  text,
  after_json   text,
  created_at   text not null,
  server_seq   bigint
);

-- ---------------------------------------------------------------------------
-- Stamp every row, index the cursor, lock every table down
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
  synced text[] := array[
    'settings','users','categories','items','customers','sales','sale_items',
    'sale_returns','sale_return_items','stock_movements',
    'customer_ledger_entries','customer_payments','expenses','audit_log'
  ];
begin
  foreach t in array synced loop
    execute format(
      'create index if not exists ix_%1$s_server_seq on %1$I (server_seq)', t);

    execute format('drop trigger if exists %1$s_stamp_seq on %1$I', t);
    execute format(
      'create trigger %1$s_stamp_seq before insert or update on %1$I
         for each row execute function stamp_server_seq()', t);

    execute format('alter table %1$I enable row level security', t);

    -- Only the shop's own people, and only through the sync function for
    -- writes. Direct writes are refused even for a member, so the conflict
    -- rules cannot be bypassed by calling the REST API.
    execute format('drop policy if exists "shop members can read" on %1$I', t);
    execute format(
      'create policy "shop members can read" on %1$I for select using (is_shop_member())', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- The two figures that are never stored, only derived
-- ---------------------------------------------------------------------------

create or replace view item_stock as
  select i.id as item_id,
         i.code,
         i.name,
         coalesce(sum(m.qty_delta), 0) as qty_on_hand
    from items i
    left join stock_movements m
      on m.item_id = i.id and m.deleted_at is null
   where i.deleted_at is null
   group by i.id, i.code, i.name;

create or replace view customer_balance as
  select c.id as customer_id,
         c.name,
         coalesce(sum(e.amount), 0) as balance
    from customers c
    left join customer_ledger_entries e
      on e.customer_id = c.id and e.deleted_at is null
   where c.deleted_at is null
   group by c.id, c.name;
