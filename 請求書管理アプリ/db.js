const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, 'data', 'app.db');
const isNewDb = !fs.existsSync(DB_PATH);

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
-- billing_nameは請求書/納品書に印字する正式宛名。未設定ならnameを使う。
-- (例: 案件管理上は取引先を「ONE」で分けたいが、書面上の宛名は法人格「SRユナイテッド株式会社」にする必要があるケース向け)
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  billing_name TEXT,
  postal_code TEXT,
  address TEXT,
  building_tel_fax TEXT,
  contact_person TEXT,
  email TEXT,
  payment_terms TEXT,
  bank_info TEXT,
  invoice_registration_number TEXT,
  notes TEXT,
  is_self INTEGER NOT NULL DEFAULT 0,
  next_invoice_no INTEGER,
  next_delivery_no INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT UNIQUE NOT NULL,
  issuer_company_id INTEGER NOT NULL REFERENCES companies(id),
  client_company_id INTEGER NOT NULL REFERENCES companies(id),
  issue_date TEXT NOT NULL,
  due_date TEXT,
  subject TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  transaction_date TEXT,
  description TEXT,
  quantity REAL,
  unit_price REAL
);

CREATE TABLE IF NOT EXISTS delivery_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_number TEXT UNIQUE NOT NULL,
  issuer_company_id INTEGER NOT NULL REFERENCES companies(id),
  client_company_id INTEGER NOT NULL REFERENCES companies(id),
  delivery_date TEXT NOT NULL,
  subject TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery_note_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_note_id INTEGER NOT NULL REFERENCES delivery_notes(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  transaction_date TEXT,
  description TEXT,
  quantity REAL,
  unit_price REAL
);

CREATE INDEX IF NOT EXISTS idx_companies_name ON companies(name);
CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_company_id);
CREATE INDEX IF NOT EXISTS idx_delivery_notes_client ON delivery_notes(client_company_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_delivery_note_items_note ON delivery_note_items(delivery_note_id);
`);

// freeeの端数処理(切り捨て)を踏襲: 消費税 = ROUNDDOWN(小計*0.1, 0)
function computeTotals(items) {
  const subtotal = items.reduce((sum, it) => sum + (Number(it.quantity) || 0) * (Number(it.unit_price) || 0), 0);
  const rounded = Math.floor(subtotal);
  const tax = Math.floor(rounded * 0.1);
  return { subtotal: rounded, tax, total: rounded + tax };
}

function padInvoiceNumber(prefix, n) {
  return `${prefix}-${String(n).padStart(10, '0')}`;
}

if (isNewDb) {
  require('./seed')(db);
}

module.exports = { db, computeTotals, padInvoiceNumber };
