/**
 * Initial schema.
 *
 * Conventions that hold across every table:
 *  - `id` is a client-generated UUIDv7 TEXT, never an autoincrement integer
 *  - money is INTEGER paisa, never REAL
 *  - quantities are REAL, because wire and cable sell by the metre
 *  - timestamps are ISO-8601 UTC TEXT, which sorts correctly as a string
 *  - `created_at` / `updated_at` / `deleted_at` exist on every synced table from
 *    day one so Stage 2 does not need a schema change on a live shop database
 *
 * Never edit this file once it has shipped. Add 002_*.ts instead.
 */
export const sql = /* sql */ `

-- ---------------------------------------------------------------------------
-- Settings and counters
-- ---------------------------------------------------------------------------

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Monotonic sequences (invoice numbers, return numbers). Incremented inside the
-- same transaction as the row that consumes the number, so a rolled-back sale
-- cannot leave a gap or hand the same number out twice.
CREATE TABLE counters (
  name   TEXT PRIMARY KEY,
  value  INTEGER NOT NULL DEFAULT 0
);

INSERT INTO counters (name, value) VALUES ('invoice', 0), ('return', 0);

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  username         TEXT NOT NULL,
  full_name        TEXT NOT NULL,
  pin_hash         TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
  permissions_json TEXT NOT NULL DEFAULT '[]',
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  -- Brute-force guard: a 4-digit PIN is only 10,000 possibilities, so the app
  -- locks an account for a while rather than relying on the PIN's strength.
  failed_attempts  INTEGER NOT NULL DEFAULT 0,
  locked_until     TEXT,
  last_login_at    TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
);

-- Usernames are unique among users that still exist; a deleted user frees its name.
CREATE UNIQUE INDEX ux_users_username ON users (username) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------

CREATE TABLE categories (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);

CREATE UNIQUE INDEX ux_categories_name ON categories (name) WHERE deleted_at IS NULL;

CREATE TABLE items (
  id               TEXT PRIMARY KEY,
  code             TEXT NOT NULL,
  name             TEXT NOT NULL,
  category_id      TEXT REFERENCES categories (id),
  unit             TEXT NOT NULL DEFAULT 'pcs',
  cost_price       INTEGER NOT NULL DEFAULT 0,
  sale_price       INTEGER NOT NULL DEFAULT 0,
  -- Bargaining floor. NULL means the cashier may go as low as they like.
  min_price        INTEGER,
  -- Cache of SUM(stock_movements.qty_delta). The movements are the truth.
  qty_on_hand      REAL NOT NULL DEFAULT 0,
  low_stock_level  REAL NOT NULL DEFAULT 0,
  photo_path       TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
);

CREATE UNIQUE INDEX ux_items_code ON items (code) WHERE deleted_at IS NULL;
CREATE INDEX ix_items_name ON items (name);
CREATE INDEX ix_items_category ON items (category_id);

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------

CREATE TABLE customers (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  phone            TEXT,
  address          TEXT,
  -- What the paper register said when the shop moved onto this system.
  opening_balance  INTEGER NOT NULL DEFAULT 0,
  -- Cache of SUM(customer_ledger_entries.amount). The entries are the truth.
  balance          INTEGER NOT NULL DEFAULT 0,
  notes            TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
);

CREATE INDEX ix_customers_name ON customers (name);
CREATE INDEX ix_customers_phone ON customers (phone);

-- ---------------------------------------------------------------------------
-- Sales
-- ---------------------------------------------------------------------------

CREATE TABLE sales (
  id              TEXT PRIMARY KEY,
  invoice_no      TEXT NOT NULL,
  customer_id     TEXT REFERENCES customers (id),
  user_id         TEXT NOT NULL REFERENCES users (id),
  sold_at         TEXT NOT NULL,
  subtotal        INTEGER NOT NULL,
  discount        INTEGER NOT NULL DEFAULT 0,
  -- Adjustment applied to reach a whole-rupee total, kept so reports reconcile.
  rounding        INTEGER NOT NULL DEFAULT 0,
  total           INTEGER NOT NULL,
  -- Amount actually received. (total - paid) went onto the customer's udhaar.
  paid            INTEGER NOT NULL DEFAULT 0,
  payment_method  TEXT NOT NULL CHECK (payment_method IN ('cash', 'wallet', 'bank', 'credit')),
  -- Cost of goods frozen at sale time, so profit never moves when prices change.
  cost_total      INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  note            TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);

CREATE UNIQUE INDEX ux_sales_invoice_no ON sales (invoice_no);
CREATE INDEX ix_sales_sold_at ON sales (sold_at);
CREATE INDEX ix_sales_customer ON sales (customer_id, sold_at);
CREATE INDEX ix_sales_user ON sales (user_id, sold_at);

CREATE TABLE sale_items (
  id          TEXT PRIMARY KEY,
  sale_id     TEXT NOT NULL REFERENCES sales (id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL REFERENCES items (id),
  -- Snapshots. The item may later be renamed, repriced or deleted; a bill that
  -- was printed for a customer must never change afterwards.
  item_code   TEXT NOT NULL,
  item_name   TEXT NOT NULL,
  unit        TEXT NOT NULL DEFAULT 'pcs',
  qty         REAL NOT NULL,
  unit_price  INTEGER NOT NULL,
  cost_price  INTEGER NOT NULL,
  line_total  INTEGER NOT NULL,
  line_no     INTEGER NOT NULL
);

CREATE INDEX ix_sale_items_sale ON sale_items (sale_id, line_no);
CREATE INDEX ix_sale_items_item ON sale_items (item_id);

-- ---------------------------------------------------------------------------
-- Returns
-- ---------------------------------------------------------------------------

CREATE TABLE sale_returns (
  id             TEXT PRIMARY KEY,
  return_no      TEXT NOT NULL,
  sale_id        TEXT NOT NULL REFERENCES sales (id),
  customer_id    TEXT REFERENCES customers (id),
  user_id        TEXT NOT NULL REFERENCES users (id),
  returned_at    TEXT NOT NULL,
  total          INTEGER NOT NULL,
  cost_total     INTEGER NOT NULL DEFAULT 0,
  refund_method  TEXT NOT NULL CHECK (refund_method IN ('cash', 'wallet', 'bank', 'credit_note')),
  reason         TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);

CREATE UNIQUE INDEX ux_sale_returns_no ON sale_returns (return_no);
CREATE INDEX ix_sale_returns_sale ON sale_returns (sale_id);
CREATE INDEX ix_sale_returns_date ON sale_returns (returned_at);

CREATE TABLE sale_return_items (
  id            TEXT PRIMARY KEY,
  return_id     TEXT NOT NULL REFERENCES sale_returns (id) ON DELETE CASCADE,
  sale_item_id  TEXT NOT NULL REFERENCES sale_items (id),
  item_id       TEXT NOT NULL REFERENCES items (id),
  item_name     TEXT NOT NULL,
  qty           REAL NOT NULL,
  unit_price    INTEGER NOT NULL,
  cost_price    INTEGER NOT NULL,
  line_total    INTEGER NOT NULL
);

CREATE INDEX ix_return_items_return ON sale_return_items (return_id);
CREATE INDEX ix_return_items_sale_item ON sale_return_items (sale_item_id);

-- ---------------------------------------------------------------------------
-- Stock movements (append-only; items.qty_on_hand is only a cache of these)
-- ---------------------------------------------------------------------------

CREATE TABLE stock_movements (
  id             TEXT PRIMARY KEY,
  item_id        TEXT NOT NULL REFERENCES items (id),
  type           TEXT NOT NULL CHECK (type IN ('opening', 'stock_in', 'sale', 'return', 'adjustment')),
  -- Signed. Stock is the running sum of these; an absolute quantity is never
  -- written directly, so nothing can silently overwrite a day of sales.
  qty_delta      REAL NOT NULL,
  qty_after      REAL NOT NULL,
  unit_cost      INTEGER,
  supplier_name  TEXT,
  reason         TEXT,
  ref_type       TEXT,
  ref_id         TEXT,
  user_id        TEXT NOT NULL REFERENCES users (id),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);

CREATE INDEX ix_stock_movements_item ON stock_movements (item_id, created_at);
CREATE INDEX ix_stock_movements_date ON stock_movements (created_at);
CREATE INDEX ix_stock_movements_ref ON stock_movements (ref_type, ref_id);

-- ---------------------------------------------------------------------------
-- Customer ledger (append-only; customers.balance is only a cache of these)
-- ---------------------------------------------------------------------------

CREATE TABLE customer_ledger_entries (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL REFERENCES customers (id),
  type           TEXT NOT NULL CHECK (type IN ('opening', 'credit_sale', 'payment', 'return_credit', 'adjustment')),
  -- Signed: positive increases what the customer owes the shop.
  amount         INTEGER NOT NULL,
  balance_after  INTEGER NOT NULL,
  ref_type       TEXT,
  ref_id         TEXT,
  ref_label      TEXT,
  note           TEXT,
  user_id        TEXT NOT NULL REFERENCES users (id),
  entry_date     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);

CREATE INDEX ix_ledger_customer ON customer_ledger_entries (customer_id, entry_date, created_at);
CREATE INDEX ix_ledger_ref ON customer_ledger_entries (ref_type, ref_id);

CREATE TABLE customer_payments (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customers (id),
  amount       INTEGER NOT NULL,
  method       TEXT NOT NULL CHECK (method IN ('cash', 'wallet', 'bank')),
  received_at  TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users (id),
  note         TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);

CREATE INDEX ix_customer_payments_customer ON customer_payments (customer_id, received_at);
CREATE INDEX ix_customer_payments_date ON customer_payments (received_at);

-- ---------------------------------------------------------------------------
-- Expenses
-- ---------------------------------------------------------------------------

CREATE TABLE expenses (
  id           TEXT PRIMARY KEY,
  category     TEXT NOT NULL,
  description  TEXT,
  amount       INTEGER NOT NULL,
  spent_at     TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users (id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);

CREATE INDEX ix_expenses_date ON expenses (spent_at);

-- ---------------------------------------------------------------------------
-- Audit log and parked bills
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  summary     TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX ix_audit_created ON audit_log (created_at);
CREATE INDEX ix_audit_entity ON audit_log (entity, entity_id);
CREATE INDEX ix_audit_user ON audit_log (user_id, created_at);

-- Bills parked mid-sale to serve another customer. Local only, never synced.
CREATE TABLE held_sales (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users (id),
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX ix_held_sales_user ON held_sales (user_id, created_at);
`;
