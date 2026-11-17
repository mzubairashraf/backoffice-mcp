-- Every table carries user_id. All queries filter on it, so one signed-in
-- user can never read or change another user's workspace.

CREATE TABLE workspaces (
  user_id      TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  invoice_seq  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE customers (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  email       TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX customers_by_user ON customers (user_id, created_at DESC);

-- Amounts are integers in the currency's minor unit (cents). No floats.
CREATE TABLE invoices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  customer_id  TEXT NOT NULL REFERENCES customers (id),
  number       TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('draft', 'open', 'paid', 'void')),
  currency     TEXT NOT NULL,
  total        INTEGER NOT NULL CHECK (total >= 0),
  amount_paid  INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid >= 0 AND amount_paid <= total),
  due_date     TEXT NOT NULL,
  memo         TEXT,
  created_at   TEXT NOT NULL,
  sent_at      TEXT,
  UNIQUE (user_id, number)
);
CREATE INDEX invoices_by_user ON invoices (user_id, created_at DESC);
CREATE INDEX invoices_by_customer ON invoices (user_id, customer_id);

CREATE TABLE invoice_lines (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  invoice_id   TEXT NOT NULL REFERENCES invoices (id),
  position     INTEGER NOT NULL,
  description  TEXT NOT NULL,
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  unit_price   INTEGER NOT NULL CHECK (unit_price >= 0)
);
CREATE INDEX lines_by_invoice ON invoice_lines (user_id, invoice_id, position);

CREATE TABLE payments (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  invoice_id   TEXT NOT NULL REFERENCES invoices (id),
  amount       INTEGER NOT NULL CHECK (amount > 0),
  method       TEXT NOT NULL,
  reference    TEXT,
  received_at  TEXT NOT NULL
);
CREATE INDEX payments_by_invoice ON payments (user_id, invoice_id);

-- One row per tool call. Arguments are not stored: they can contain personal
-- data, and the object IDs in "summary" are enough to trace what happened.
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  at         TEXT NOT NULL,
  client_id  TEXT,
  tool       TEXT NOT NULL,
  outcome    TEXT NOT NULL,
  summary    TEXT
);
CREATE INDEX audit_by_user ON audit_log (user_id, id DESC);
