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

// A candidate signs up with a mobile number or an email (at least one).
const usersTable = name => `
CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY,
  phone TEXT UNIQUE,
  email TEXT UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  cmr INTEGER,
  state TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  logins INTEGER NOT NULL DEFAULT 0,
  CHECK (phone IS NOT NULL OR email IS NOT NULL)
);`;
const columns = table => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);

// Pending codes live for minutes only, so an old-layout table is simply replaced.
if (columns('otp_requests').includes('phone')) db.exec('DROP TABLE otp_requests');

db.exec(usersTable('users') + `
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS otp_requests (
  id INTEGER PRIMARY KEY,
  contact TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  profile TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS otp_contact ON otp_requests(contact, created_at);

CREATE TABLE IF NOT EXISTS datasets (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '',
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
  stream TEXT NOT NULL, category TEXT NOT NULL, quota TEXT NOT NULL DEFAULT '', seats INTEGER NOT NULL,
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

-- Sign-up details kept from the moment a code is requested, so a lead isn't lost
-- when the code never arrives. verified_at is set once that contact signs in.
CREATE TABLE IF NOT EXISTS signup_attempts (
  id INTEGER PRIMARY KEY,
  contact TEXT NOT NULL,
  channel TEXT NOT NULL,
  name TEXT NOT NULL,
  cmr INTEGER,
  state TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  verified_at INTEGER
);
CREATE INDEX IF NOT EXISTS attempts_contact ON signup_attempts(contact, created_at);

-- Built-in data files (server/seed/) already loaded, so each loads once and stays deleted if an admin removes it.
CREATE TABLE IF NOT EXISTS seeds (file TEXT PRIMARY KEY, loaded_at INTEGER NOT NULL);
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
  const blank = Object.fromEntries(def.columns.map(c => [c.name, c.type === 'int' ? 0 : '']));
  for (const r of rows) stmt.run(datasetId, ...cols.map(c => r[c] ?? blank[c]));
}

// ---- migrations for databases created before sign-up asked for CMR + state
if (!columns('users').includes('email')) {
  // SQLite can't relax NOT NULL in place: rebuild the table. Foreign keys are
  // off for the swap so dropping the old table doesn't cascade to sessions.
  db.exec('PRAGMA foreign_keys = OFF');
  tx(() => db.exec(usersTable('users_new') + `
    INSERT INTO users_new (id, phone, name, created_at, last_seen_at, logins)
      SELECT id, phone, name, created_at, last_seen_at, logins FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;`));
  db.exec('PRAGMA foreign_keys = ON');
}
// Passwords (local test mode and email accounts; phone accounts on Firebase keep theirs there).
if (!columns('users').includes('password_hash')) db.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT NOT NULL DEFAULT ''`);
if (!columns('state_rows').includes('quota')) db.exec(`ALTER TABLE state_rows ADD COLUMN quota TEXT NOT NULL DEFAULT ''`);
if (!columns('datasets').includes('state')) {
  // Every dataset before per-state data was the client's Odisha data.
  db.exec(`ALTER TABLE datasets ADD COLUMN state TEXT NOT NULL DEFAULT '';
    UPDATE datasets SET state = 'Odisha';`);
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

// ---- built-in data (server/seed/) -----------------------------------------
// Each file loads once. On a fresh database (Render's free tier starts empty after every
// restart) they all load; an existing database gets only the files it hasn't had yet.
const SEEDS = [
  { file: 'odisha-state-2025.json', kind: 'state', state: 'Odisha', year: 2025, label: 'Odisha state counselling 2025',
    notes: 'Imported from the original RankRound Odisha page.' },
  { file: 'odisha-aiq-2025.json', kind: 'aiq', state: 'Odisha', year: 2025, label: 'All India Quota — Odisha colleges 2025–26',
    notes: 'Imported from the original RankRound Odisha page.' },
  { file: 'gujarat-state-2025.json', kind: 'state', state: 'Gujarat', year: 2025, label: 'Gujarat state counselling 2025 · final closing ranks',
    notes: "ACPPGMEC 'Institutewise Last Rank' PG-2025 (final round), via the client's workbook. Only the last admitted rank is published: no opening ranks or seat counts. Seats converted to another quota are left out." },
  { file: 'gujarat-state-2024.json', kind: 'state', state: 'Gujarat', year: 2024, label: 'Gujarat state counselling 2024 · final closing ranks',
    notes: "ACPPGMEC 'Institutewise Last Rank' PG-2024 (final round), via the client's workbook. Only the last admitted rank is published: no opening ranks or seat counts. Seats converted to another quota are left out." }
];
for (const s of SEEDS) {
  if (db.prepare('SELECT 1 FROM seeds WHERE file = ?').get(s.file)) continue;
  // Databases from before this list already hold the Odisha data under the same name.
  const exists = db.prepare('SELECT 1 FROM datasets WHERE kind = ? AND state = ? AND label = ?').get(s.kind, s.state, s.label);
  tx(() => {
    if (!exists) {
      const rows = JSON.parse(fs.readFileSync(path.join(here, 'seed', s.file), 'utf8'));
      if (s.kind === 'aiq') for (const r of rows) { r.open_rank = r.open; r.close_rank = r.close; }
      const t = now();
      const { lastInsertRowid } = db.prepare(
        'INSERT INTO datasets (kind, state, label, year, notes, published, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
        .run(s.kind, s.state, s.label, s.year, s.notes, t, t);
      insertRows(s.kind, Number(lastInsertRowid), rows);
      console.log(`[db] loaded ${s.label}`);
    }
    db.prepare('INSERT INTO seeds (file, loaded_at) VALUES (?, ?)').run(s.file, now());
  });
}
