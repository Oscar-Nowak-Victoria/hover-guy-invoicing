-- Hover Guy quoting & invoicing. Money is stored in cents, dates as ISO strings (YYYY-MM-DD).

CREATE TABLE IF NOT EXISTS settings (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  business_name        TEXT NOT NULL DEFAULT 'Hover Guy',
  sender_name          TEXT NOT NULL DEFAULT 'Oscar',
  address              TEXT NOT NULL DEFAULT '',
  abn                  TEXT NOT NULL DEFAULT '',
  email                TEXT NOT NULL DEFAULT '',        -- the accounts address invoices are sent from
  phone                TEXT NOT NULL DEFAULT '',
  currency             TEXT NOT NULL DEFAULT 'AUD',
  tax_label            TEXT NOT NULL DEFAULT 'GST',
  tax_rate             REAL NOT NULL DEFAULT 0.10,
  payment_terms_days   INTEGER NOT NULL DEFAULT 14,
  quote_valid_days     INTEGER NOT NULL DEFAULT 30,
  bank_account_name    TEXT NOT NULL DEFAULT 'Hover Guy',
  bank_bsb             TEXT NOT NULL DEFAULT '',
  bank_account_number  TEXT NOT NULL DEFAULT '',
  invoice_terms        TEXT NOT NULL DEFAULT 'Payment due within {days} days by bank transfer. Please quote {number} with your payment.',
  quote_terms          TEXT NOT NULL DEFAULT 'Valid for {days} days. Weather cancellations rebooked free. Client cancellation under 48 hours: 50% of crew fees. Invoice issued on completion.',
  quote_included       TEXT NOT NULL DEFAULT 'Flight plan, risk assessment, airspace checks and NOTAM review.',
  reminders_enabled    INTEGER NOT NULL DEFAULT 1,
  timezone             TEXT NOT NULL DEFAULT 'Australia/Brisbane',
  next_number          INTEGER NOT NULL DEFAULT 1        -- one HG-0000 sequence shared by quotes and invoices
);
INSERT OR IGNORE INTO settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS clients (
  id                   INTEGER PRIMARY KEY,
  company              TEXT NOT NULL,
  contact_name         TEXT NOT NULL DEFAULT '',
  email                TEXT NOT NULL,
  accounts_email       TEXT NOT NULL DEFAULT '',          -- invoices and reminders go here when set
  address              TEXT NOT NULL DEFAULT '',
  abn                  TEXT NOT NULL DEFAULT '',
  payment_terms_days   INTEGER,                           -- overrides settings when set
  reminders_enabled    INTEGER NOT NULL DEFAULT 1,
  notes                TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rate_card (
  id                   INTEGER PRIMARY KEY,
  name                 TEXT NOT NULL,
  detail               TEXT NOT NULL DEFAULT '',
  unit                 TEXT NOT NULL DEFAULT '',
  unit_price           INTEGER NOT NULL,                   -- cents, excluding tax
  taxable              INTEGER NOT NULL DEFAULT 1,
  active               INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS quotes (
  id                   INTEGER PRIMARY KEY,
  number               TEXT NOT NULL UNIQUE,
  client_id            INTEGER NOT NULL REFERENCES clients(id),
  title                TEXT NOT NULL,
  summary              TEXT NOT NULL DEFAULT '',
  site                 TEXT NOT NULL DEFAULT '',
  job_date             TEXT,
  issued_on            TEXT NOT NULL,
  valid_until          TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','sent','accepted','declined','expired')),
  sent_at              TEXT,
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invoices (
  id                   INTEGER PRIMARY KEY,
  number               TEXT NOT NULL UNIQUE,
  client_id            INTEGER NOT NULL REFERENCES clients(id),
  quote_id             INTEGER REFERENCES quotes(id),
  client_po            TEXT NOT NULL DEFAULT '',
  title                TEXT NOT NULL,
  summary              TEXT NOT NULL DEFAULT '',
  issued_on            TEXT NOT NULL,
  due_on               TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','sent','paid','void')),
  sent_at              TEXT,
  reminders_paused     INTEGER NOT NULL DEFAULT 0,          -- e.g. client disputed it or promised a date
  needs_attention      INTEGER NOT NULL DEFAULT 0,          -- set after the final notice
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS line_items (
  id                   INTEGER PRIMARY KEY,
  quote_id             INTEGER REFERENCES quotes(id) ON DELETE CASCADE,
  invoice_id           INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
  position             INTEGER NOT NULL,
  description          TEXT NOT NULL,
  detail               TEXT NOT NULL DEFAULT '',
  quantity             REAL NOT NULL,
  unit                 TEXT NOT NULL DEFAULT '',
  unit_price           INTEGER NOT NULL,                   -- cents, excluding tax
  taxable              INTEGER NOT NULL DEFAULT 1,
  CHECK ((quote_id IS NULL) <> (invoice_id IS NULL))
);

CREATE TABLE IF NOT EXISTS payments (
  id                   INTEGER PRIMARY KEY,
  invoice_id           INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount               INTEGER NOT NULL,                   -- cents
  received_on          TEXT NOT NULL,
  method               TEXT NOT NULL DEFAULT 'Bank transfer',
  reference            TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS reminders (
  id                   INTEGER PRIMARY KEY,
  invoice_id           INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  step                 TEXT NOT NULL CHECK (step IN ('pre_due','due','overdue_7','overdue_14','final_30')),
  status               TEXT NOT NULL CHECK (status IN ('sent','skipped','failed')),
  on_date              TEXT NOT NULL,
  detail               TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (invoice_id, step)
);

CREATE TABLE IF NOT EXISTS emails (                       -- every email sent or saved to the outbox
  id                   INTEGER PRIMARY KEY,
  kind                 TEXT NOT NULL,                      -- quote, invoice, reminder:<step>
  quote_id             INTEGER REFERENCES quotes(id) ON DELETE SET NULL,
  invoice_id           INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  to_address           TEXT NOT NULL,
  subject              TEXT NOT NULL,
  mode                 TEXT NOT NULL,                      -- outbox or smtp
  file                 TEXT,                               -- .eml path when saved to the outbox
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
