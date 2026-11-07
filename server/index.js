import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, now, tx, insertRows, getSettings, putSettings } from './db.js';
import { KINDS, parseTable, aggregate, validateRecord } from './schema.js';
import {
  PROVIDER, FIREBASE, OTP_LENGTH, EMAIL_ENABLED, HttpError, attachUser, requireUser, requireAdmin, isAdmin, publicUser,
  readProfile, requestOtp, verifyOtp, passwordSignIn, firebaseSignIn, adminLogin, endSession,
  saveAttempt, firebaseDomainStatus, phoneSignInReady
} from './auth.js';
import { visitor, record, ingest, dashboard } from './analytics.js';
import { STATES, ALL_INDIA, normState } from './states.js';
import { registry, guideList, compareTable, roadmap, stateSeats, documents, updates, guidePage, GUIDES_DIR, DATA_DIR } from './guides.js';
import { regionOf, regionKey, regionInfo, sectionOf, regionData, access } from './regions.js';
import { sections } from './sections.js';

registry(); // a malformed guides/guides.json stops the server here, with the reason

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');
const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  next();
});
app.use('/api/admin', express.json({ limit: '20mb' }));
app.use(express.json({ limit: '64kb' }));
app.use(attachUser, visitor);

// Mutating API calls must be JSON — blocks cross-site form posts. A body-less
// fetch POST (sign-out) still sends Content-Length: 0 but no Content-Type, so a
// request with no type and no content passes; anything else must be JSON.
app.use('/api', (req, _res, next) => {
  const empty = !req.headers['content-type'] && !(Number(req.headers['content-length']) > 0);
  if (req.method !== 'GET' && req.method !== 'HEAD' && !empty && !req.is('application/json'))
    return next(new HttpError(415, 'Expected JSON.'));
  next();
});

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const int = v => { const n = parseInt(v, 10); if (!(n > 0)) throw new HttpError(400, 'Bad id.'); return n; };
const kindOf = k => { if (!KINDS[k]) throw new HttpError(400, 'Unknown dataset kind.'); return k; };

function datasetSummary(d) {
  const t = KINDS[d.kind].table;
  const s = db.prepare(`SELECT COUNT(*) rows, COALESCE(SUM(seats),0) seats, COUNT(DISTINCT college) colleges FROM ${t} WHERE dataset_id = ?`).get(d.id);
  return { id: d.id, kind: d.kind, state: d.state, label: d.label, year: d.year, notes: d.notes, published: !!d.published,
    updatedAt: d.updated_at, createdAt: d.created_at, ...s };
}
// Signed-in candidates see All India Quota data and their own state's counselling data (other
// states' data is locked); visitors see what exists.
const VISIBLE = `published = 1 AND (kind = 'aiq' OR state = ?)`;
const publishedSets = user => (user
  ? db.prepare(`SELECT * FROM datasets WHERE ${VISIBLE} ORDER BY year DESC, id DESC`).all(user.state)
  : db.prepare('SELECT * FROM datasets WHERE published = 1 ORDER BY year DESC, id DESC').all()).map(datasetSummary);
// A dataset is tagged with a state, or "All India" for national All India Quota data.
const datasetState = (kind, s) => kind === 'aiq' && s === ALL_INDIA ? ALL_INDIA : normState(s);
// States with published data: the state a dataset is tagged with, and (unless only state counselling is asked
// for) the college states inside national All India data.
const dataStates = (kind = null) => {
  const tagged = db.prepare(`SELECT DISTINCT state FROM datasets WHERE published = 1 AND state <> ?${kind ? ' AND kind = ?' : ''}`)
    .all(ALL_INDIA, ...(kind ? [kind] : [])).map(r => r.state);
  const national = kind === 'state' ? [] : db.prepare(`SELECT DISTINCT r.state FROM aiq_rows r JOIN datasets d ON d.id = r.dataset_id
    WHERE d.published = 1 AND r.state <> ''`).all().map(r => r.state);
  return [...new Set([...tagged, ...national])].sort();
};

// ======================================================================
// Public
// ======================================================================
app.get('/api/config', (req, res) => {
  const s = getSettings();
  res.json({
    auth: { provider: PROVIDER, otpLength: OTP_LENGTH, email: EMAIL_ENABLED, firebase: PROVIDER === 'firebase' ? FIREBASE : null,
      phoneReady: phoneSignInReady(req.hostname) },
    settings: { brand: s.brand, announcement: s.announcement, whatsapp: s.whatsapp, contactEmail: s.contact_email },
    states: STATES,
    dataStates: dataStates(),
    stateData: dataStates('state'),
    datasets: publishedSets(req.user),
    guides: guideList().map(({ slug, region, title, label }) => ({ slug, region, title, label })),
    highlight: registry().highlight || null,
    // Which regions have which data on their roadmap page: { Odisha: ['merit', 'seats'], … }
    regionData: (registry().data || []).reduce((o, d) => ({ ...o, [d.region]: [...new Set([...(o[d.region] || []), d.kind])] }), {}),
    // Regions whose merit list shows no NEET-PG ranks (Tamil Nadu): candidates find their CMR by name.
    meritByName: (registry().data || []).filter(d => d.kind === 'merit' && d.byName).map(d => d.region),
    user: publicUser(req.user)
  });
});
app.get('/api/guides', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json({ guides: guideList(), compare: compareTable(), roadmap: roadmap(), seats: stateSeats(), documents: documents(), updates: updates() });
});

// Sign-up details, sent just before a code is requested (stage "send") and again if sending
// fails (stage "failed", with the error). Firebase sends its SMS straight from the browser,
// so this is also where its code requests are counted.
app.post('/api/auth/attempt', (req, res) => {
  const b = req.body || {};
  const { channel } = saveAttempt(req, b);
  if (b.stage === 'send' && PROVIDER === 'firebase' && channel === 'phone') record(req, 'otp_request', { channel, via: 'firebase' });
  res.json({ ok: true });
});
app.post('/api/auth/otp/request', wrap(async (req, res) => {
  const out = await requestOtp(req, req.body || {});
  record(req, 'otp_request', { channel: out.channel });
  res.json({ ok: true, ...out, mock: PROVIDER === 'mock' });
}));
app.post('/api/auth/otp/verify', wrap((req, res) => {
  const { user, isNew } = verifyOtp(req, res, req.body || {});
  record(req, 'login', { isNew }, { userId: user.id });
  res.json({ user: publicUser(user), isNew });
}));
app.post('/api/auth/password', wrap((req, res) => {
  const { user, isNew } = passwordSignIn(req, res, req.body || {});
  record(req, 'login', { isNew, via: 'password' }, { userId: user.id });
  res.json({ user: publicUser(user), isNew });
}));
app.post('/api/auth/firebase', wrap(async (req, res) => {
  const { user, isNew } = await firebaseSignIn(req, res, req.body || {});
  record(req, 'login', { isNew, via: 'firebase' }, { userId: user.id });
  res.json({ user: publicUser(user), isNew });
}));
app.post('/api/auth/logout', (req, res) => { endSession(req, res, 'user'); res.json({ ok: true }); });
app.get('/api/me', (req, res) => res.json({ user: publicUser(req.user) }));
app.patch('/api/me', requireUser, (req, res) => {
  const p = readProfile(req.body || {});
  const u = { ...req.user, ...p };
  if (!u.name || !u.air || !u.state) throw new HttpError(400, 'Enter your name, NEET-PG rank and state.');
  db.prepare('UPDATE users SET name = ?, air = ?, cmr = ?, state = ? WHERE id = ?').run(u.name, u.air, u.cmr ?? null, u.state, u.id);
  if (u.state !== req.user.state || u.cmr !== req.user.cmr || u.air !== req.user.air)
    record(req, 'profile_update', { state: u.state, air: u.air, cmr: u.cmr ?? null });
  res.json({ user: publicUser(u) });
});

app.post('/api/events', ingest);
// For uptime pings (the free host sleeps when idle): no database, no analytics.
app.get('/healthz', (_req, res) => { res.set('Cache-Control', 'no-store').type('text').send('ok'); });

// ---- counselling roadmap pages (one per region) -------------------------
const regionParam = key => { const r = regionOf(key); if (!r) throw new HttpError(404, 'No such state.'); return r; };
app.get('/api/regions/:key', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json(regionInfo(regionParam(req.params.key), req.user, isAdmin(req)));
});
app.get('/api/sections/:slug/:id', (req, res) => {
  const s = sectionOf(req.params.slug, req.params.id);
  if (!s) throw new HttpError(404, 'That section is not in the guide.');
  res.set('Cache-Control', 'no-cache');
  res.json(s);
});
// Data needs an account: All India data for everyone signed in, a state's data for its own candidates.
app.get('/api/regions/:key/data/:id', (req, res) => {
  const region = regionParam(req.params.key);
  const a = access(req.user, region, isAdmin(req));
  if (a === 'signin') throw new HttpError(401, 'Sign in to see this data.');
  if (a === 'locked') throw new HttpError(403, `${region} data is open to candidates registered for ${region}.`);
  const d = regionData(region, req.params.id);
  if (!d) throw new HttpError(404, 'No such data.');
  record(req, 'region_data', { region, id: d.meta.id });
  res.set('Cache-Control', 'private, no-cache').type('json').send(d.json);
});

// The national PG seat matrix (NMC), for the "Seat matrix" section: any signed-in candidate.
const NMC_SEATS = path.join(DATA_DIR, 'all-india', 'nmc-seat-matrix-2026.json');
app.get('/api/seat-matrix', requireUser, (req, res) => {
  record(req, 'region_data', { region: 'All India', id: 'nmc-seat-matrix' });
  res.set('Cache-Control', 'private, no-cache').type('json').sendFile(NMC_SEATS);
});

// Row data is only for signed-in users.
app.get('/api/datasets/:id', requireUser, (req, res) => {
  const d = db.prepare(`SELECT * FROM datasets WHERE id = ? AND ${VISIBLE}`).get(int(req.params.id), req.user.state);
  if (!d) throw new HttpError(404, 'Dataset not found.');
  const def = KINDS[d.kind];
  const cols = def.columns.map(c => c.name);
  const rows = db.prepare(`SELECT ${cols.join(', ')} FROM ${def.table} WHERE dataset_id = ?`).all(d.id).map(r => cols.map(c => r[c]));
  res.set('Cache-Control', 'private, max-age=60');
  res.json({ dataset: datasetSummary(d), columns: cols, rows });
});

// ---- shortlist ---------------------------------------------------------
// The quota is appended only when a seat has one, so keys saved before quotas existed still match.
const rowKey = (kind, row) => KINDS[kind].key.map(k => String(row[k] ?? '')).join(' | ')
  + (kind === 'aiq' ? ' | ' + row.type : '') + (row.quota ? ' | ' + row.quota : '') + (kind === 'aiq' && row.state ? ' | ' + row.state : '');
const shortlistOf = uid => db.prepare('SELECT id, kind, row_key, snapshot, position, created_at FROM shortlist WHERE user_id = ? ORDER BY position, id').all(uid)
  .map(r => ({ id: r.id, kind: r.kind, key: r.row_key, createdAt: r.created_at, ...JSON.parse(r.snapshot) }));

app.get('/api/shortlist', requireUser, (req, res) => res.json({ items: shortlistOf(req.user.id) }));
app.post('/api/shortlist', requireUser, (req, res) => {
  const kind = kindOf(req.body?.kind);
  const row = req.body?.row || {};
  const [rec, errors] = validateRecord(kind, row);
  if (errors.length) throw new HttpError(400, 'That seat could not be saved.');
  const n = db.prepare('SELECT COUNT(*) n, COALESCE(MAX(position), 0) p FROM shortlist WHERE user_id = ?').get(req.user.id);
  if (n.n >= 150) throw new HttpError(400, 'Your shortlist is full (150 seats).');
  const snapshot = JSON.stringify({ row: rec, dataset: String(req.body?.dataset || '').slice(0, 120) });
  db.prepare(`INSERT INTO shortlist (user_id, kind, row_key, snapshot, position, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, kind, row_key) DO NOTHING`).run(req.user.id, kind, rowKey(kind, rec), snapshot, n.p + 1, now());
  record(req, 'shortlist_add', { scope: kind, college: rec.college, spec: rec.speciality || rec.branch });
  res.json({ items: shortlistOf(req.user.id) });
});
app.delete('/api/shortlist/:id', requireUser, (req, res) => {
  db.prepare('DELETE FROM shortlist WHERE id = ? AND user_id = ?').run(int(req.params.id), req.user.id);
  res.json({ items: shortlistOf(req.user.id) });
});
app.put('/api/shortlist/order', requireUser, (req, res) => {
  const ids = (req.body?.ids || []).map(Number).filter(Boolean).slice(0, 200);
  tx(() => {
    const st = db.prepare('UPDATE shortlist SET position = ? WHERE id = ? AND user_id = ?');
    ids.forEach((id, i) => st.run(i + 1, id, req.user.id));
  });
  res.json({ items: shortlistOf(req.user.id) });
});

// ======================================================================
// Admin
// ======================================================================
app.post('/api/admin/login', (req, res) => { adminLogin(req, res, req.body?.password); res.json({ ok: true }); });
app.post('/api/admin/logout', (req, res) => { endSession(req, res, 'admin'); res.json({ ok: true }); });
app.get('/api/admin/me', (req, res) => res.json({ admin: isAdmin(req), provider: PROVIDER, email: EMAIL_ENABLED, states: STATES, allIndia: ALL_INDIA }));
app.use('/api/admin', requireAdmin);

app.get('/api/admin/health', wrap(async (req, res) => {
  res.json({ provider: PROVIDER, email: EMAIL_ENABLED, firebase: await firebaseDomainStatus(req.hostname) });
}));

app.get('/api/admin/analytics', (req, res) => {
  const days = [7, 30, 90].includes(+req.query.days) ? +req.query.days : 30;
  res.json(dashboard(days));
});

// ---- leads -------------------------------------------------------------
function leads(q) {
  const like = '%' + String(q || '').trim() + '%';
  return db.prepare(`SELECT u.id, u.name, u.phone, u.email, u.air, u.cmr, u.state, u.created_at, u.last_seen_at, u.logins,
      (SELECT COUNT(*) FROM events e WHERE e.user_id = u.id AND e.type = 'predict') predictions,
      (SELECT props FROM events e WHERE e.user_id = u.id AND e.type = 'predict' ORDER BY e.ts DESC LIMIT 1) last_predict,
      (SELECT COUNT(*) FROM shortlist s WHERE s.user_id = u.id) shortlisted
    FROM users u WHERE u.phone LIKE ? OR u.email LIKE ? OR u.name LIKE ? OR u.state LIKE ?
    ORDER BY u.created_at DESC LIMIT 2000`).all(like, like, like, like)
    .map(u => {
      const p = u.last_predict ? JSON.parse(u.last_predict) : {};
      return { id: u.id, name: u.name, phone: u.phone, email: u.email, air: u.air, cmr: u.cmr, state: u.state,
        createdAt: u.created_at, lastSeenAt: u.last_seen_at, logins: u.logins,
        predictions: u.predictions, shortlisted: u.shortlisted,
        lastScope: p.scope || '', lastRank: p.rank || null, lastStream: p.stream || '', lastCategory: p.category || '' };
    });
}
const csvCell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csv = (head, rows) => '﻿' + [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
const istDate = ms => ms ? new Date(ms + 19800e3).toISOString().slice(0, 16).replace('T', ' ') : '';
function sendCsv(res, name, body) {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
  res.send(body);
}

app.get('/api/admin/leads', (req, res) => {
  const list = leads(req.query.q);
  if (req.query.format !== 'csv') return res.json({ leads: list });
  sendCsv(res, `rankround-leads-${new Date().toISOString().slice(0, 10)}.csv`, csv(
    ['Name', 'Mobile', 'Email', 'State', 'NEET-PG rank (AIR)', 'State CMR', 'Signed up (IST)', 'Last active (IST)', 'Sign-ins', 'Predictions', 'Shortlisted', 'Last counselling', 'Last rank', 'Last stream', 'Last category'],
    list.map(l => [l.name, l.phone, l.email, l.state, l.air ?? '', l.cmr ?? '', istDate(l.createdAt), istDate(l.lastSeenAt), l.logins, l.predictions, l.shortlisted,
      l.lastScope === 'state' ? 'State' : l.lastScope === 'aiq' ? 'AIQ' : '', l.lastRank ?? '', l.lastStream, l.lastCategory])));
});
app.get('/api/admin/leads/:id', (req, res) => {
  const id = int(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) throw new HttpError(404, 'Not found.');
  const activity = db.prepare(`SELECT ts, type, path, props FROM events WHERE user_id = ? AND type <> 'pageview' ORDER BY ts DESC LIMIT 40`).all(id)
    .map(e => ({ ...e, props: JSON.parse(e.props) }));
  res.json({ user: { id: u.id, name: u.name, phone: u.phone, email: u.email, air: u.air, cmr: u.cmr, state: u.state,
    createdAt: u.created_at, lastSeenAt: u.last_seen_at, logins: u.logins },
    shortlist: shortlistOf(id), activity });
});
app.delete('/api/admin/leads/:id', (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(int(req.params.id));
  res.json({ ok: true });
});

// Sign-ups that never verified: the latest attempt per contact that has no account.
function attempts(q) {
  const like = '%' + String(q || '').trim() + '%';
  return db.prepare(`SELECT a.id, a.contact, a.channel, a.name, a.air, a.state, a.error, a.created_at, a.updated_at
    FROM signup_attempts a
    WHERE a.verified_at IS NULL
      AND a.id = (SELECT MAX(b.id) FROM signup_attempts b WHERE b.contact = a.contact)
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.phone = a.contact OR u.email = a.contact)
      AND (a.contact LIKE ? OR a.name LIKE ? OR a.state LIKE ?)
    ORDER BY a.updated_at DESC LIMIT 2000`).all(like, like, like)
    .map(a => ({ id: a.id, name: a.name, contact: a.contact, channel: a.channel, air: a.air, state: a.state, error: a.error,
      createdAt: a.created_at, updatedAt: a.updated_at }));
}
app.get('/api/admin/attempts', (req, res) => {
  const list = attempts(req.query.q);
  if (req.query.format !== 'csv') return res.json({ attempts: list });
  sendCsv(res, `rankround-unverified-${new Date().toISOString().slice(0, 10)}.csv`, csv(
    ['Name', 'Mobile or email', 'State', 'NEET-PG rank (AIR)', 'First tried (IST)', 'Last tried (IST)', 'Problem'],
    list.map(a => [a.name, a.contact, a.state, a.air ?? '', istDate(a.createdAt), istDate(a.updatedAt), a.error || 'Code not entered'])));
});
app.delete('/api/admin/attempts/:id', (req, res) => {
  const a = db.prepare('SELECT contact FROM signup_attempts WHERE id = ?').get(int(req.params.id));
  if (a) db.prepare('DELETE FROM signup_attempts WHERE contact = ? AND verified_at IS NULL').run(a.contact);
  res.json({ ok: true });
});

// ---- datasets ----------------------------------------------------------
app.get('/api/admin/schema', (_req, res) => res.json(
  Object.fromEntries(Object.entries(KINDS).map(([k, d]) => [k, { label: d.label, rank: d.rank, columns: d.columns, allotment: d.allotment }]))));

app.get('/api/admin/template', (req, res) => {
  const kind = kindOf(req.query.kind);
  const fmt = req.query.format === 'allotment' ? 'allotment' : 'columns';
  const cols = KINDS[kind][fmt];
  const sample = {
    state: { columns: ['SCB MCH Cuttack', 'General Medicine', 'MD/MS', 'Direct', 'UR', '', 5, 1, 17, 106, 872, 5, 'R-1 UGR-1'],
      allotment: ['SCB MCH Cuttack', 'General Medicine', 'MD/MS', 'Direct', 'UR', '', 1, 106, 'R-1'] },
    aiq: { columns: ['SCB Medical College, Cuttack', 'Government', 'MD - General Medicine', 'GENERAL', 'All India', 7, 193, 100683, 'Odisha'],
      allotment: ['SCB Medical College, Cuttack', 'Government', 'MD - General Medicine', 'GENERAL', 'All India', 193, 'Odisha'] }
  }[kind][fmt];
  sendCsv(res, `template-${kind}-${fmt === 'columns' ? 'cutoffs' : 'allotments'}.csv`, csv(cols.map(c => c.name), [sample]));
});

function prepareUpload(body) {
  const kind = kindOf(body.kind);
  const allot = body.format === 'allotment';
  const def = KINDS[kind];
  if (!Array.isArray(body.table) || body.table.length < 2) throw new HttpError(400, 'The file has no data rows.');
  if (body.table.length > 100001) throw new HttpError(400, 'Files are limited to 100,000 rows.');
  const parsed = parseTable(body.table, allot ? def.allotment : def.columns);
  if (parsed.missing.length) return { kind, rows: [], input: 0, errors: [], missing: parsed.missing };
  let rows = allot ? aggregate(kind, parsed.rows) : parsed.rows;
  const errors = [...parsed.errors];
  if (!allot) rows = rows.filter((r, i) => {
    const [, errs] = validateRecord(kind, r);
    if (errs.length && errors.length < 50) errors.push({ line: i + 2, message: errs[0] });
    return !errs.length;
  });
  return { kind, rows, input: body.table.length - 1, accepted: parsed.rows.length, errors, missing: [] };
}
const uploadReport = p => ({
  input: p.input, accepted: p.accepted, rows: p.rows.length, seats: p.rows.reduce((s, r) => s + r.seats, 0),
  colleges: new Set(p.rows.map(r => r.college)).size, errors: p.errors, missing: p.missing, sample: p.rows.slice(0, 30)
});

app.get('/api/admin/datasets', (_req, res) =>
  res.json({ datasets: db.prepare('SELECT * FROM datasets ORDER BY kind, state, year DESC, id DESC').all().map(datasetSummary) }));

app.post('/api/admin/datasets/preview', (req, res) => res.json(uploadReport(prepareUpload(req.body || {}))));

app.post('/api/admin/datasets', (req, res) => {
  const b = req.body || {};
  const p = prepareUpload(b);
  if (p.missing.length) throw new HttpError(400, 'Missing columns: ' + p.missing.join(', '));
  if (!p.rows.length) throw new HttpError(400, 'No valid rows to import.');
  const label = String(b.label || '').trim().slice(0, 120);
  const year = parseInt(b.year, 10);
  const state = datasetState(p.kind, b.state);
  if (!state) throw new HttpError(400, 'Choose the state this data is for.');
  if (!label) throw new HttpError(400, 'Give the dataset a name.');
  if (!(year >= 2000 && year <= 2100)) throw new HttpError(400, 'Enter the counselling year.');
  const id = tx(() => {
    const t = now();
    const r = db.prepare('INSERT INTO datasets (kind, state, label, year, notes, published, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.kind, state, label, year, String(b.notes || '').slice(0, 1000), b.publish ? 1 : 0, t, t);
    insertRows(p.kind, Number(r.lastInsertRowid), p.rows);
    return Number(r.lastInsertRowid);
  });
  res.json({ dataset: datasetSummary(db.prepare('SELECT * FROM datasets WHERE id = ?').get(id)) });
});

const getDataset = id => {
  const d = db.prepare('SELECT * FROM datasets WHERE id = ?').get(int(id));
  if (!d) throw new HttpError(404, 'Dataset not found.');
  return d;
};
const touch = id => db.prepare('UPDATE datasets SET updated_at = ? WHERE id = ?').run(now(), id);

app.post('/api/admin/datasets/:id/replace', (req, res) => {
  const d = getDataset(req.params.id);
  const p = prepareUpload({ ...req.body, kind: d.kind });
  if (p.missing.length) throw new HttpError(400, 'Missing columns: ' + p.missing.join(', '));
  if (!p.rows.length) throw new HttpError(400, 'No valid rows to import.');
  const mode = req.body?.mode === 'append' ? 'append' : 'replace';
  tx(() => {
    if (mode === 'replace') db.prepare(`DELETE FROM ${KINDS[d.kind].table} WHERE dataset_id = ?`).run(d.id);
    insertRows(d.kind, d.id, p.rows);
    touch(d.id);
  });
  res.json({ dataset: datasetSummary(getDataset(d.id)) });
});

app.patch('/api/admin/datasets/:id', (req, res) => {
  const d = getDataset(req.params.id);
  const b = req.body || {};
  const label = b.label !== undefined ? String(b.label).trim().slice(0, 120) : d.label;
  const year = b.year !== undefined ? parseInt(b.year, 10) : d.year;
  const state = b.state !== undefined ? datasetState(d.kind, b.state) : d.state;
  if (!state) throw new HttpError(400, 'Choose the state this data is for.');
  if (!label) throw new HttpError(400, 'Give the dataset a name.');
  if (!(year >= 2000 && year <= 2100)) throw new HttpError(400, 'Enter the counselling year.');
  db.prepare('UPDATE datasets SET state = ?, label = ?, year = ?, notes = ?, published = ?, updated_at = ? WHERE id = ?')
    .run(state, label, year, b.notes !== undefined ? String(b.notes).slice(0, 1000) : d.notes,
      b.published !== undefined ? (b.published ? 1 : 0) : d.published, now(), d.id);
  res.json({ dataset: datasetSummary(getDataset(d.id)) });
});
app.delete('/api/admin/datasets/:id', (req, res) => {
  const d = getDataset(req.params.id);
  db.prepare('DELETE FROM datasets WHERE id = ?').run(d.id);
  res.json({ ok: true });
});

app.get('/api/admin/datasets/:id/rows', (req, res) => {
  const d = getDataset(req.params.id);
  const def = KINDS[d.kind];
  const rows = db.prepare(`SELECT id, ${def.columns.map(c => c.name).join(', ')} FROM ${def.table} WHERE dataset_id = ? ORDER BY college, id`).all(d.id);
  res.json({ dataset: datasetSummary(d), columns: def.columns, rows });
});
app.get('/api/admin/datasets/:id/export', (req, res) => {
  const d = getDataset(req.params.id);
  const def = KINDS[d.kind];
  const cols = def.columns.map(c => c.name);
  const rows = db.prepare(`SELECT ${cols.join(', ')} FROM ${def.table} WHERE dataset_id = ? ORDER BY college, id`).all(d.id);
  const slug = d.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  sendCsv(res, `${slug || 'dataset'}.csv`, csv(cols, rows.map(r => cols.map(c => r[c]))));
});

function saveRow(d, body, rowId) {
  const def = KINDS[d.kind];
  const [rec, errors] = validateRecord(d.kind, body || {});
  if (errors.length) throw new HttpError(400, errors.join('. ') + '.');
  const cols = def.columns.map(c => c.name);
  if (rowId) {
    const r = db.prepare(`UPDATE ${def.table} SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ? AND dataset_id = ?`)
      .run(...cols.map(c => rec[c]), rowId, d.id);
    if (!r.changes) throw new HttpError(404, 'Row not found.');
  } else insertRows(d.kind, d.id, [rec]);
  touch(d.id);
}
app.post('/api/admin/datasets/:id/rows', (req, res) => { saveRow(getDataset(req.params.id), req.body); res.json({ ok: true }); });
app.patch('/api/admin/datasets/:id/rows/:rowId', (req, res) => {
  saveRow(getDataset(req.params.id), req.body, int(req.params.rowId)); res.json({ ok: true });
});
app.delete('/api/admin/datasets/:id/rows/:rowId', (req, res) => {
  const d = getDataset(req.params.id);
  db.prepare(`DELETE FROM ${KINDS[d.kind].table} WHERE id = ? AND dataset_id = ?`).run(int(req.params.rowId), d.id);
  touch(d.id);
  res.json({ ok: true });
});

// ---- settings ----------------------------------------------------------
app.get('/api/admin/settings', (_req, res) => res.json({ settings: getSettings(), provider: PROVIDER }));
app.put('/api/admin/settings', (req, res) => {
  const b = req.body || {};
  if (b.whatsapp && !/^\+?\d[\d\s-]{8,16}$/.test(b.whatsapp)) throw new HttpError(400, 'WhatsApp number should be digits, with country code.');
  putSettings(b);
  res.json({ settings: getSettings() });
});

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));

// ======================================================================
// Pages
// ======================================================================
const page = file => (_req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(PUBLIC, file)); };
app.get(['/', '/predict', '/cutoffs', '/shortlist', '/seats', '/method', '/counselling', '/counselling/', '/roadmap', '/roadmap/{*rest}'], page('index.html'));
app.get(['/admin', '/admin/'], page('admin.html'));

// Counselling guides: one page per guide, framed by server/guides.js.
app.get('/counselling.html', (_req, res) => res.redirect(301, '/counselling'));
app.use('/counselling/assets', express.static(path.join(GUIDES_DIR, 'assets'), { index: false, maxAge: '1d' }));
// The searchable result, merit list and All India seat explorers moved into the roadmap pages, behind sign-in.
const MOVED = { 'mcc-round1-result': '/roadmap/all-india/round-1/allotment', 'odisha-merit-list': '/roadmap/odisha/merit-list',
  ...Object.fromEntries(['dnb-seats', 'deemed-seats', 'central-quota-seats'].map(s => [s, '/roadmap/all-india/round-1/choice-filling'])),
  'odisha-seats': '/roadmap/odisha/round-1/choice-filling' };
app.get('/counselling/:slug', (req, res) => {
  if (MOVED[req.params.slug]) return res.redirect(301, MOVED[req.params.slug]);
  // One place per state: a guide opens in its roadmap page, section by section; "?original" shows the page as the client wrote it.
  const g = registry().guides.find(x => x.slug === req.params.slug);
  if (g && !('original' in req.query) && sections(path.join(GUIDES_DIR, g.file)).length)
    return res.redirect(302, `/roadmap/${regionKey(g.region)}/registration/${g.slug}`);
  const html = guidePage(req.params.slug);
  if (!html) return res.redirect(302, '/counselling');
  res.set('Cache-Control', 'no-cache').type('html').send(html);
});

// no-cache = revalidate on every load (a cheap 304 when unchanged). With a max-age, a browser
// could pair a freshly deployed app.js with a cached lib.js for up to an hour after a deploy.
app.use(express.static(PUBLIC, { index: false, setHeaders: res => res.set('Cache-Control', 'no-cache') }));

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.too.large') err = new HttpError(413, 'That upload is too large.');
  if (err.type === 'entity.parse.failed') err = new HttpError(400, 'Malformed JSON.');
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on our side.' : err.message });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`RankRound running on http://localhost:${port}  (auth: ${PROVIDER})`));
