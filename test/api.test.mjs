// Integration tests: a real server on a throw-away database, in test sign-in mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 4300 + Math.floor(Math.random() * 600);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `rankround-test-${process.pid}.db`);
let server;

test.before(async () => {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, AUTH_PROVIDER: 'mock', MOCK_OTP: '1234', ADMIN_PASSWORD: 'test-pw', NODE_ENV: 'test', TRUST_PROXY: '' },
    stdio: 'ignore'
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/api/config')).ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
test.after(async () => {
  // Windows keeps the database locked until the server process has fully exited.
  if (server && server.exitCode === null) await new Promise(r => { server.once('exit', r); server.kill(); });
  for (const f of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(f, { force: true });
});

/** fetch with a tiny cookie jar per "browser". */
function browser() {
  const jar = new Map();
  return async (p, { method = 'GET', body, headers = {}, redirect = 'manual' } = {}) => {
    const h = { ...headers };
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(body); }
    const r = await fetch(BASE + p, { method, body, headers: h, redirect });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, headers: r.headers, text, json };
  };
}
const signUp = { mode: 'signup', channel: 'phone', name: 'Test Student', cmr: '1592', state: 'Odisha' };
const PW = 'good-password-1';

test('guides: index data, pages, redirects and assets', async () => {
  const b = browser();
  const g = await b('/api/guides');
  assert.equal(g.status, 200);
  assert.ok(g.json.guides.length >= 20 && g.json.compare.rows.length);
  assert.ok(g.json.roadmap.stages.length >= 5, 'the counselling roadmap is served');
  assert.ok(g.json.documents.length >= 28 && g.json.updates.length >= 20, 'documents and updates are served');
  const pdf = await b('/counselling/assets/' + g.json.documents[0].file);
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get('content-type'), /application\/pdf/);
  const page = await b('/counselling/kerala-checklist');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  assert.match(page.text, /data-guide="kerala-checklist"/);
  assert.equal((await b('/counselling')).status, 200, 'index is served by the app');
  assert.equal((await b('/counselling/')).status, 200);
  const unknown = await b('/counselling/nowhere');
  assert.equal(unknown.status, 302);
  assert.equal(unknown.headers.get('location'), '/counselling');
  const old = await b('/counselling.html');
  assert.equal(old.status, 301);
  const img = await b('/counselling/assets/mcc-schedule-p1.jpg');
  assert.equal(img.status, 200);
  assert.match(img.headers.get('content-type'), /image\/jpeg/);
});

test('app scripts and styles are revalidated on every load', async () => {
  const b = browser();
  for (const p of ['/js/app.js', '/js/lib.js', '/css/app.css', '/js/guide.js', '/css/guide.css']) {
    const r = await b(p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get('cache-control'), 'no-cache', p);
  }
});

test('config lists the guides and says phone sign-in is ready', async () => {
  const c = (await browser()('/api/config')).json;
  assert.ok(c.guides.some(g => g.slug === 'odisha' && g.region === 'Odisha'));
  assert.equal(c.auth.phoneReady, true);
});

test('sign-up keeps the details first, then signs in and clears them from the unverified list', async () => {
  const student = browser(), admin = browser();
  assert.equal((await admin('/api/admin/login', { method: 'POST', body: { password: 'test-pw' } })).status, 200);
  const att = await student('/api/auth/attempt', { method: 'POST', body: { ...signUp, phone: '9000000101', stage: 'send' } });
  assert.equal(att.status, 200);
  let list = (await admin('/api/admin/attempts')).json.attempts;
  assert.ok(list.some(a => a.contact === '+919000000101' && a.name === 'Test Student' && a.cmr === 1592 && a.state === 'Odisha'));
  assert.equal((await student('/api/auth/otp/request', { method: 'POST', body: { ...signUp, phone: '9000000101' } })).status, 200);
  const v = await student('/api/auth/otp/verify', { method: 'POST', body: { channel: 'phone', phone: '9000000101', code: '1234', password: PW } });
  assert.equal(v.status, 200);
  assert.equal(v.json.user.state, 'Odisha');
  list = (await admin('/api/admin/attempts')).json.attempts;
  assert.equal(list.some(a => a.contact === '+919000000101'), false, 'a verified student leaves the list');
});

test('a failed code request is kept with its reason, and exports to CSV', async () => {
  const student = browser(), admin = browser();
  await admin('/api/admin/login', { method: 'POST', body: { password: 'test-pw' } });
  await student('/api/auth/attempt', { method: 'POST', body: { ...signUp, name: 'Stuck Student', phone: '9000000102', stage: 'send' } });
  await student('/api/auth/attempt', { method: 'POST', body: { ...signUp, name: 'Stuck Student', phone: '9000000102', stage: 'failed', error: 'captcha-check-failed' } });
  const list = (await admin('/api/admin/attempts')).json.attempts.filter(a => a.contact === '+919000000102');
  assert.equal(list.length, 1, 'one row per student');
  assert.equal(list[0].error, 'captcha-check-failed');
  const csv = await admin('/api/admin/attempts?format=csv');
  assert.match(csv.text, /Stuck Student,\+919000000102,Odisha,1592/);
  assert.equal((await admin('/api/admin/attempts/' + list[0].id, { method: 'DELETE' })).status, 200);
  assert.equal((await admin('/api/admin/attempts')).json.attempts.some(a => a.contact === '+919000000102'), false);
});

test('attempts need the full sign-up details', async () => {
  const r = await browser()('/api/auth/attempt', { method: 'POST', body: { channel: 'phone', phone: '9000000103', name: 'No State', cmr: '5' } });
  assert.equal(r.status, 400);
});

test('admin endpoints need the admin session', async () => {
  const b = browser();
  for (const p of ['/api/admin/attempts', '/api/admin/health']) assert.equal((await b(p)).status, 401, p);
});

test('admin health reports the sign-in provider', async () => {
  const admin = browser();
  await admin('/api/admin/login', { method: 'POST', body: { password: 'test-pw' } });
  const h = (await admin('/api/admin/health')).json;
  assert.equal(h.provider, 'mock');
  assert.equal(h.firebase, null);
});

test('sign-out works for a body-less POST, as browsers send it', async () => {
  const b = browser();
  await b('/api/auth/otp/request', { method: 'POST', body: { ...signUp, phone: '9000000104' } });
  await b('/api/auth/otp/verify', { method: 'POST', body: { channel: 'phone', phone: '9000000104', code: '1234', password: PW } });
  assert.ok((await b('/api/me')).json.user);
  const out = await b('/api/auth/logout', { method: 'POST', headers: { 'content-length': '0' } });
  assert.equal(out.status, 200);
  assert.equal((await b('/api/me')).json.user, null);
});

test('Gujarat closing-rank data is built in, with quotas, for Gujarat students only', async () => {
  const b = browser();
  await b('/api/auth/otp/request', { method: 'POST', body: { ...signUp, state: 'Gujarat', phone: '9000000105' } });
  await b('/api/auth/otp/verify', { method: 'POST', body: { channel: 'phone', phone: '9000000105', code: '1234', password: PW } });
  const sets = (await b('/api/config')).json.datasets;
  assert.deepEqual(sets.map(d => `${d.state} ${d.kind} ${d.year}`).sort(), ['Gujarat aiq 2026', 'Gujarat state 2024', 'Gujarat state 2025']);
  const d = (await b('/api/datasets/' + sets.find(x => x.kind === 'state' && x.year === 2025).id)).json;
  const col = n => d.columns.indexOf(n);
  assert.ok(d.rows.length > 1800);
  assert.ok(d.rows.every(r => r[col('seats')] === 0 && r[col('cmr_open')] === r[col('cmr_close')]), 'only the last admitted rank, no seat count');
  assert.ok(new Set(d.rows.map(r => r[col('quota')])).has('Government (GQ)'));
  // a Gujarat seat shortlists with its quota as part of the key
  const row = Object.fromEntries(d.columns.map((c, i) => [c, d.rows[0][i]]));
  const sl = await b('/api/shortlist', { method: 'POST', body: { kind: 'state', row, dataset: d.dataset.label } });
  assert.equal(sl.status, 200);
  assert.ok(sl.json.items[0].key.endsWith(' | ' + row.quota));
  // an Odisha student still sees only Odisha data
  const o = browser();
  await o('/api/auth/otp/request', { method: 'POST', body: { ...signUp, phone: '9000000106' } });
  await o('/api/auth/otp/verify', { method: 'POST', body: { channel: 'phone', phone: '9000000106', code: '1234', password: PW } });
  assert.ok((await o('/api/config')).json.datasets.every(x => x.state === 'Odisha'));
});

test('cross-site form posts are still refused', async () => {
  const r = await fetch(BASE + '/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
  assert.equal(r.status, 415);
});

test('sign-up sets a password; sign-in then needs only the password', async () => {
  const a = browser();
  await a('/api/auth/otp/request', { method: 'POST', body: { ...signUp, phone: '9000000110' } });
  const short = await a('/api/auth/otp/verify', { method: 'POST', body: { channel: 'phone', phone: '9000000110', code: '1234', password: 'short' } });
  assert.equal(short.status, 400, 'passwords under 8 characters are refused');
  assert.equal((await a('/api/auth/otp/verify', { method: 'POST', body: { channel: 'phone', phone: '9000000110', code: '1234', password: PW } })).status, 200);
  const b = browser();
  const wrong = await b('/api/auth/password', { method: 'POST', body: { channel: 'phone', phone: '9000000110', password: 'not-the-one' } });
  assert.equal(wrong.status, 401);
  assert.match(wrong.json.error, /Wrong mobile number or password/);
  const nobody = await b('/api/auth/password', { method: 'POST', body: { channel: 'phone', phone: '9000000119', password: PW } });
  assert.equal(nobody.status, 401, 'an unknown number gets the same answer');
  assert.equal(nobody.json.error, wrong.json.error);
  const ok = await b('/api/auth/password', { method: 'POST', body: { channel: 'phone', phone: '90000 00110', password: PW } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.name, 'Test Student');
  assert.equal(ok.json.isNew, false);
});

test('forgot password: a code to the phone, then a new password', async () => {
  const a = browser();
  await a('/api/auth/otp/request', { method: 'POST', body: { ...signUp, phone: '9000000111' } });
  await a('/api/auth/otp/verify', { method: 'POST', body: { channel: 'phone', phone: '9000000111', code: '1234', password: PW } });
  const b = browser();
  assert.equal((await b('/api/auth/otp/request', { method: 'POST', body: { mode: 'reset', channel: 'phone', phone: '9000000111' } })).status, 200, 'no profile needed to reset');
  const none = await b('/api/auth/otp/verify', { method: 'POST', body: { channel: 'phone', phone: '9000000111', code: '1234' } });
  assert.equal(none.status, 400, 'a reset needs the new password');
  assert.equal((await b('/api/auth/otp/request', { method: 'POST', body: { mode: 'reset', channel: 'phone', phone: '9000000111' } })).status, 429, 'the resend limit still applies');
});

test('forgot password sets the new password and keeps the profile', async () => {
  const a = browser();
  await a('/api/auth/otp/request', { method: 'POST', body: { ...signUp, phone: '9000000112' } });
  await a('/api/auth/otp/verify', { method: 'POST', body: { channel: 'phone', phone: '9000000112', code: '1234', password: PW } });
  const b = browser();
  await b('/api/auth/otp/request', { method: 'POST', body: { mode: 'reset', channel: 'phone', phone: '9000000112' } });
  const r = await b('/api/auth/otp/verify', { method: 'POST', body: { channel: 'phone', phone: '9000000112', code: '1234', password: 'brand-new-pass' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.cmr, 1592);
  const c = browser();
  assert.equal((await c('/api/auth/password', { method: 'POST', body: { channel: 'phone', phone: '9000000112', password: PW } })).status, 401, 'the old password stops working');
  assert.equal((await c('/api/auth/password', { method: 'POST', body: { channel: 'phone', phone: '9000000112', password: 'brand-new-pass' } })).status, 200);
});

test('"Keep me logged in" decides how long the sign-in lasts', async () => {
  const a = browser();
  await a('/api/auth/otp/request', { method: 'POST', body: { ...signUp, phone: '9000000113' } });
  await a('/api/auth/otp/verify', { method: 'POST', body: { channel: 'phone', phone: '9000000113', code: '1234', password: PW } });
  const keep = await fetch(BASE + '/api/auth/password', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'phone', phone: '9000000113', password: PW, remember: true }) });
  assert.match(keep.headers.getSetCookie().find(c => c.startsWith('rr_sid=')), /Max-Age=2592000/, '30 days');
  const brief = await fetch(BASE + '/api/auth/password', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'phone', phone: '9000000113', password: PW, remember: false }) });
  assert.doesNotMatch(brief.headers.getSetCookie().find(c => c.startsWith('rr_sid=')), /Max-Age/, 'ends when the browser closes');
});

test('MCC 2026 Round 1 is built in as All India cut-offs for every state, with quotas', async () => {
  const visitor = (await browser()('/api/config')).json;
  const r1 = visitor.datasets.filter(d => d.kind === 'aiq' && d.year === 2026);
  assert.equal(r1.length, 35, 'one dataset per state with Round 1 allotments');
  assert.equal(r1.reduce((n, d) => n + d.seats, 0), 28584, 'every allotment is counted');
  assert.deepEqual(visitor.stateData, ['Gujarat', 'Odisha'], 'state-counselling data is listed separately');
  const b = browser();
  await b('/api/auth/otp/request', { method: 'POST', body: { ...signUp, state: 'Maharashtra', phone: '9000000120' } });
  await b('/api/auth/otp/verify', { method: 'POST', body: { channel: 'phone', phone: '9000000120', code: '1234', password: PW } });
  const sets = (await b('/api/config')).json.datasets;
  assert.deepEqual(sets.map(d => `${d.state} ${d.kind} ${d.year}`), ['Maharashtra aiq 2026']);
  const d = (await b('/api/datasets/' + sets[0].id)).json;
  const rows = d.rows.map(a => Object.fromEntries(d.columns.map((c, i) => [c, a[i]])));
  const quotas = new Set(rows.map(r => r.quota));
  for (const q of ['All India', 'Self-Financed Merit Seat', 'DNB Quota']) assert.ok(quotas.has(q), q);
  assert.ok(rows.every(r => r.open_rank <= r.close_rank && r.seats >= 1 && ['Government', 'Private'].includes(r.type)));
  // a seat with a quota shortlists with it as part of the key
  const row = rows.find(r => r.quota === 'Self-Financed Merit Seat');
  const sl = await b('/api/shortlist', { method: 'POST', body: { kind: 'aiq', row, dataset: d.dataset.label } });
  assert.ok(sl.json.items[0].key.endsWith(` | ${row.type} | Self-Financed Merit Seat`));
});
