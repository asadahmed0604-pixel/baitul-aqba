import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_SETTINGS = {
  foundationName: 'Bait ul Aqba',
  currency: 'PKR',
  timezone: 'Asia/Karachi',
  // Receipt quality gates
  minOcrConfidence: 55, // Tesseract mean confidence (0-100)
  minSharpness: 40, // Laplacian variance measured in the browser; lower = blurrier
  minImageSide: 400, // pixels, shortest side
  maxUploadMb: 8,
  requireReceiptDateInCurrentMonth: true,
  rejectWhenOcrDatesOutsideMonth: true,
  // Month allocation window
  maxAdvanceMonths: 12,
  maxArrearsMonths: 3,
  allowDonorRegistration: true,
  // Accounts the foundation expects donations to be paid into.
  officialAccounts: [], // [{ title, bank, account }]
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('donor','admin')),
  name TEXT NOT NULL,
  email TEXT UNIQUE COLLATE NOCASE,
  phone TEXT UNIQUE,
  city TEXT,
  password_hash TEXT,
  session_version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS orphans (
  id INTEGER PRIMARY KEY,
  orphan_no TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  guardian_name TEXT,
  date_of_birth TEXT,
  city TEXT,
  monthly_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS donor_orphans (
  donor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  orphan_id INTEGER NOT NULL REFERENCES orphans(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (donor_id, orphan_id)
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  donor_id INTEGER NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  payment_date TEXT NOT NULL,
  bank_name TEXT,
  transaction_ref TEXT,
  sender_name TEXT,
  sender_account TEXT,
  beneficiary_name TEXT,
  beneficiary_account TEXT,
  beneficiary_bank TEXT,
  receipt_text TEXT,
  ocr_text TEXT,
  ocr_confidence REAL,
  sharpness REAL,
  image_path TEXT,
  image_hash TEXT,
  image_width INTEGER,
  image_height INTEGER,
  donor_note TEXT,
  admin_note TEXT,
  flags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  source TEXT NOT NULL DEFAULT 'donor' CHECK (source IN ('donor','admin','import')),
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS payments_date ON payments(payment_date);
CREATE INDEX IF NOT EXISTS payments_donor ON payments(donor_id);
CREATE INDEX IF NOT EXISTS payments_ref ON payments(transaction_ref);
CREATE INDEX IF NOT EXISTS payments_hash ON payments(image_hash);
CREATE TABLE IF NOT EXISTS payment_months (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  orphan_id INTEGER NOT NULL REFERENCES orphans(id),
  month TEXT NOT NULL,
  amount REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS pm_orphan_month ON payment_months(orphan_id, month);
CREATE INDEX IF NOT EXISTS pm_month ON payment_months(month);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Columns added after the first release. Each runs once, only when the column is missing.
const MIGRATIONS = [
  ['orphans', 'name_ar', 'TEXT'],
  ['orphans', 'child_phone', 'TEXT'],
  ['users', 'sponsor_code', 'TEXT'],
];
function migrate(db) {
  for (const [table, column, type] of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

let savepointSeq = 0;
/** Run fn atomically. Uses savepoints so calls can nest (e.g. an import dry-run wrapping many entries). */
export function tx(db, fn) {
  const sp = `sp_${++savepointSeq}`;
  db.exec(`SAVEPOINT ${sp}`);
  try {
    const out = fn();
    db.exec(`RELEASE ${sp}`);
    return out;
  } catch (e) {
    db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  }
}

export function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    if (r.key in DEFAULT_SETTINGS) {
      try { s[r.key] = JSON.parse(r.value); } catch { /* keep default */ }
    }
  }
  return s;
}

export function saveSettings(db, patch) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) {
    if (k in DEFAULT_SETTINGS) stmt.run(k, JSON.stringify(v));
  }
  return getSettings(db);
}

export function audit(db, userId, action, entity, entityId, details) {
  db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)')
    .run(userId ?? null, action, entity ?? null, entityId ?? null, details ? JSON.stringify(details) : null);
}
