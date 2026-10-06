import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KINDS } from './schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(process.env.DB_PATH || path.join(here, '..', 'data', 'rankround.db'));
fs.mkdirSync(path.dirname(file), { recursive: true });

export const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  logins INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS otp_requests (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS otp_phone ON otp_requests(phone, created_at);

CREATE TABLE IF NOT EXISTS datasets (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  year INTEGER NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  published INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS state_rows (
  id INTEGER PRIMARY KEY,
  dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  college TEXT NOT NULL, speciality TEXT NOT NULL, programme TEXT NOT NULL,
  stream TEXT NOT NULL, category TEXT NOT NULL, seats INTEGER NOT NULL,
  cmr_open INTEGER NOT NULL, cmr_close INTEGER NOT NULL,
  air_open INTEGER NOT NULL DEFAULT 0, air_close INTEGER NOT NULL DEFAULT 0,
  air_seen INTEGER NOT NULL DEFAULT 0, rounds TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS state_ds ON state_rows(dataset_id);
CREATE TABLE IF NOT EXISTS aiq_rows (
  id INTEGER PRIMARY KEY,
  dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  college TEXT NOT NULL, type TEXT NOT NULL, branch TEXT NOT NULL, category TEXT NOT NULL,
  seats INTEGER NOT NULL, open_rank INTEGER NOT NULL, close_rank INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS aiq_ds ON aiq_rows(dataset_id);

CREATE TABLE IF NOT EXISTS shortlist (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  row_key TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, kind, row_key)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  visitor_id TEXT NOT NULL,
  user_id INTEGER,
  type TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '',
  referrer TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  props TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_type_ts ON events(type, ts);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

export const now = () => Date.now();

/** Run fn inside a transaction; roll back if it throws. */
export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function insertRows(kind, datasetId, rows) {
  const def = KINDS[kind];
  const cols = def.columns.map(c => c.name);
  const stmt = db.prepare(
    `INSERT INTO ${def.table} (dataset_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`);
  for (const r of rows) stmt.run(datasetId, ...cols.map(c => r[c]));
}

// ---- settings ----------------------------------------------------------
export const SETTING_DEFAULTS = {
  brand: 'RankRound',
  announcement: '',
  whatsapp: '',
  contact_email: ''
};
export function getSettings() {
  const out = { ...SETTING_DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}
export function putSettings(obj) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const k of Object.keys(SETTING_DEFAULTS))
    if (k in obj) stmt.run(k, String(obj[k] ?? '').slice(0, 500));
}

// ---- first-run seed: the client's 2025 Odisha data ---------------------
if (!db.prepare('SELECT 1 FROM datasets LIMIT 1').get()) {
  const seed = (kind, label, file) => {
    const rows = JSON.parse(fs.readFileSync(path.join(here, 'seed', file), 'utf8'));
    if (kind === 'aiq') for (const r of rows) { r.open_rank = r.open; r.close_rank = r.close; }
    tx(() => {
      const t = now();
      const { lastInsertRowid } = db.prepare(
        'INSERT INTO datasets (kind, label, year, notes, published, created_at, updated_at) VALUES (?, ?, 2025, ?, 1, ?, ?)')
        .run(kind, label, 'Imported from the original RankRound Odisha page.', t, t);
      insertRows(kind, Number(lastInsertRowid), rows);
    });
  };
  seed('state', 'Odisha state counselling 2025', 'odisha-state-2025.json');
  seed('aiq', 'All India Quota — Odisha colleges 2025–26', 'odisha-aiq-2025.json');
  console.log('[db] seeded 2025 Odisha datasets');
}
