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
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, AUTH_PROVIDER: 'mock', MOCK_OTP: '1234', ADMIN_PASSWORD: 'test-pw', NODE_ENV: 'test', TRUST_PROXY: '', FULL_ACCESS_PHONES: '+91 90000 00113' },
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
const signUp = { mode: 'signup', channel: 'phone', name: 'Test Student', air: '15920', state: 'Odisha' };
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
  // one place per state: a guide opens on its roadmap page; ?original shows the client's own layout
  const go = await b('/counselling/kerala-checklist');
  assert.equal(go.status, 302);
  assert.equal(go.headers.get('location'), '/roadmap/kerala/registration/kerala-checklist');
  assert.equal((await b('/counselling/kerala-seats')).status, 200, 'a seat tool with no sections still opens as it is');
  const page = await b('/counselling/kerala-checklist?original');
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
  assert.ok(list.some(a => a.contact === '+919000000101' && a.name === 'Test Student' && a.air === 15920 && a.state === 'Odisha'));
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
  const r = await browser()('/api/auth/attempt', { method: 'POST', body: { channel: 'phone', phone: '9000000103', name: 'No State', air: '5' } });
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

test('Gujarat closing-rank data is built in, with quotas, for Gujarat students only (All India data for everyone)', async () => {
  const b = browser();
  await b('/api/auth/otp/request', { method: 'POST', body: { ...signUp, state: 'Gujarat', phone: '9000000105' } });
  await b('/api/auth/otp/verify', { method: 'POST', body: { channel: 'phone', phone: '9000000105', code: '1234', password: PW } });
  const sets = (await b('/api/config')).json.datasets;
  assert.deepEqual(sets.map(d => `${d.state} ${d.kind} ${d.year}`).sort(), ['All India aiq 2026', 'Gujarat state 2024', 'Gujarat state 2025', 'Odisha aiq 2025']);
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
  // an Odisha student sees Odisha's state counselling data, never Gujarat's (other states are locked)
  const o = browser();
  await o('/api/auth/otp/request', { method: 'POST', body: { ...signUp, phone: '9000000106' } });
  await o('/api/auth/otp/verify', { method: 'POST', body: { channel: 'phone', phone: '9000000106', code: '1234', password: PW } });
  const mine = (await o('/api/config')).json.datasets;
  assert.ok(mine.filter(x => x.kind === 'state').every(x => x.state === 'Odisha'));
  assert.ok(mine.some(x => x.kind === 'aiq' && x.state === 'All India'), 'and the national All India data');
  assert.equal((await o('/api/datasets/' + sets.find(x => x.kind === 'state').id)).status, 404, "Gujarat's rows stay locked");
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
  assert.equal(r.json.user.air, 15920);
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

test('MCC 2026 Round 1 is built in as one national All India dataset, with quotas and college states', async () => {
  const visitor = (await browser()('/api/config')).json;
  const r1 = visitor.datasets.filter(d => d.kind === 'aiq' && d.year === 2026);
  assert.equal(r1.length, 1, 'one dataset for the whole country');
  assert.equal(r1[0].state, 'All India');
  assert.equal(r1[0].seats, 28584, 'every allotment is counted');
  assert.deepEqual(visitor.stateData, ['Gujarat', 'Odisha'], 'state-counselling data is listed separately');
  const b = browser();
  await b('/api/auth/otp/request', { method: 'POST', body: { ...signUp, state: 'Maharashtra', phone: '9000000120' } });
  await b('/api/auth/otp/verify', { method: 'POST', body: { channel: 'phone', phone: '9000000120', code: '1234', password: PW } });
  const sets = (await b('/api/config')).json.datasets;
  assert.deepEqual(sets.map(d => `${d.state} ${d.kind} ${d.year}`), ['All India aiq 2026', 'Odisha aiq 2025'], 'a Maharashtra candidate sees all All India data');
  const d = (await b('/api/datasets/' + sets[0].id)).json;
  const rows = d.rows.map(a => Object.fromEntries(d.columns.map((c, i) => [c, a[i]])));
  assert.equal(new Set(rows.map(r => r.state)).size, 35, 'each seat carries its college state');
  for (const p of [/^MD /, /^MS /, /^DNB (?!Diploma)/, /^DNB Diploma /]) assert.ok(rows.some(r => p.test(r.branch)), `programme ${p}`);
  const quotas = new Set(rows.map(r => r.quota));
  for (const q of ['All India', 'Self-Financed Merit Seat', 'DNB Quota']) assert.ok(quotas.has(q), q);
  assert.ok(rows.every(r => r.open_rank <= r.close_rank && r.seats >= 1 && ['Government', 'Private'].includes(r.type)));
  // a seat with a quota shortlists with it as part of the key
  const row = rows.find(r => r.quota === 'Self-Financed Merit Seat');
  const sl = await b('/api/shortlist', { method: 'POST', body: { kind: 'aiq', row, dataset: d.dataset.label } });
  assert.ok(sl.json.items[0].key.endsWith(` | ${row.type} | Self-Financed Merit Seat | ${row.state}`));
});

test('roadmap pages: guides and stages for everyone, data by account and state', async () => {
  const v = browser();
  const od = (await v('/api/regions/odisha')).json;
  assert.equal(od.region, 'Odisha');
  assert.deepEqual(od.stages, ['Registration', 'Merit List', 'Round 1', 'Round 2', 'Round 3', 'Stray Vacancy']);
  assert.equal(od.progress.stage, 'Round 1');
  assert.equal(od.access, 'signin');
  assert.deepEqual(od.data.map(d => d.id).sort(), ['allotment-round-1', 'merit-list-2026', 'seat-matrix-round-1']);
  const guide = od.guides.find(g => g.slug === 'odisha');
  assert.ok(guide.sections.some(s => s.id === 'key-dates'), 'guide sections are listed');
  const sec = (await v('/api/sections/odisha/key-dates')).json;
  assert.match(sec.html, /Provisional merit list/);
  assert.doesNotMatch(sec.html, /<(script|style|svg|button)\b|\b(class|style|onclick)=/, 'cleaned to plain content');
  assert.equal((await v('/api/sections/odisha/no-such-section')).status, 404);
  assert.equal((await v('/api/regions/atlantis')).status, 404);
  // data: signed out → 401; another state → 403; own state and All India → the data
  assert.equal((await v('/api/regions/odisha/data/merit-list-2026')).status, 401);
  assert.equal((await v('/api/regions/all-india/data/allotment-round-1')).status, 401);
  const k = browser();
  await k('/api/auth/otp/request', { method: 'POST', body: { ...signUp, state: 'Kerala', phone: '9000000130' } });
  await k('/api/auth/otp/verify', { method: 'POST', body: { channel: 'phone', phone: '9000000130', code: '1234', password: PW } });
  assert.equal((await k('/api/regions/odisha')).json.access, 'locked');
  assert.equal((await k('/api/regions/odisha/data/merit-list-2026')).status, 403);
  const all = await k('/api/regions/all-india/data/allotment-round-1');
  assert.equal(all.status, 200);
  assert.equal(all.json.rows.length, 28584);
  assert.deepEqual(all.json.type, ['Government', 'Private'], 'All India allotments carry Govt / private');
  const aiqSeats = (await k('/api/regions/all-india/data/seat-matrix-round-1')).json.rows;
  const by = prog => aiqSeats.filter(r => r.programme === prog).reduce((n, r) => n + r.seats, 0);
  assert.deepEqual([by('MD/MS') + by('DNB') + by('Diploma'), by('DNB') + aiqSeats.filter(r => r.quota === 'DNB Quota' && r.programme === 'Diploma').reduce((n, r) => n + r.seats, 0)], [17445, 9201],
    'All India seat matrix: DNB 9,201 + deemed 7,537 + central quota 707');
  assert.ok(aiqSeats.every(r => r.state && ['Government', 'Private'].includes(r.type)));
  const o = browser();
  await o('/api/auth/otp/request', { method: 'POST', body: { ...signUp, phone: '9000000131' } });
  await o('/api/auth/otp/verify', { method: 'POST', body: { channel: 'phone', phone: '9000000131', code: '1234', password: PW } });
  const merit = (await o('/api/regions/odisha/data/merit-list-2026')).json;
  assert.deepEqual(merit.lists.map(l => `${l.label} ${l.rows.length}`), ['Direct 1216', 'In-service 312', 'PMN Diploma 185', 'Rejected 34']);
  const seats = (await o('/api/regions/odisha/data/seat-matrix-round-1')).json.rows;
  const sum = (stream, quota) => seats.filter(r => r.stream === stream && r.quota === quota).reduce((n, r) => n + r.seats, 0);
  assert.deepEqual([sum('Direct', 'State quota'), sum('In-service', 'State quota'), sum('Direct', 'Management quota'), sum('In-service', 'Management quota')], [193, 193, 39, 38],
    "the printed totals of Odisha's revised seat matrix");
  // the two standalone pages moved behind sign-in, into the roadmap pages
  const moved = await v('/counselling/odisha-merit-list');
  assert.equal(moved.status, 301);
  assert.equal(moved.headers.get('location'), '/roadmap/odisha/merit-list');
  assert.equal((await v('/counselling/dnb-seats')).headers.get('location'), '/roadmap/all-india/round-1/choice-filling');
  assert.equal((await v('/counselling/odisha-seats')).headers.get('location'), '/roadmap/odisha/round-1/choice-filling', "Odisha's old seat explorer: the revised matrix");
  assert.equal((await v('/counselling/assets/mcc-round1-2026.json')).status, 404, 'the result file is no longer public');
  assert.equal((await v('/roadmap/odisha/round-1')).status, 200);
});

test('Chhattisgarh, Tamil Nadu, Uttar Pradesh and Uttarakhand: merit list, seat matrix and allotment as printed', async () => {
  const sum = rows => rows.reduce((n, r) => n + r.seats, 0);
  const STATES = [
    ['Chhattisgarh', 'chhattisgarh', [['MD/MS', 874]], 453, 278],
    ['Tamil Nadu', 'tamil-nadu', [['Government quota', 7969], ['Management quota', 3644], ['DNB and 2-year diploma (service)', 71]], 2430, 1409 + 468 + 11 + 12],
    ['Uttar Pradesh', 'uttar-pradesh', [['MD/MS and diploma', 6084], ['DNB (post-MBBS DNB and diploma)', 96]], 4125, 2904],
    ['Uttarakhand', 'uttarakhand', [['MD/MS (regular)', 1021], ['NRI quota', 13]], 488, 315]
  ];
  for (const [state, key, lists, seats, allotted] of STATES) {
    const b = browser(), phone = '90000002' + String(STATES.findIndex(s => s[0] === state)).padStart(2, '0');
    await b('/api/auth/otp/request', { method: 'POST', body: { ...signUp, state, phone } });
    await b('/api/auth/otp/verify', { method: 'POST', body: { channel: 'phone', phone, code: '1234', password: PW } });
    const merit = (await b(`/api/regions/${key}/data/merit-list-2026`)).json;
    for (const [label, n] of lists) assert.equal(merit.lists.find(l => l.label === label)?.rows.length, n, `${state}: ${label}`);
    assert.equal(sum((await b(`/api/regions/${key}/data/seat-matrix-round-1`)).json.rows), seats, `${state}: seats`);
    const a = (await b(`/api/regions/${key}/data/allotment-round-1`)).json;
    assert.equal(a.format, 'state');
    assert.equal(a.rows.length, allotted, `${state}: allotted`);
    assert.equal((await b('/api/regions/odisha/data/merit-list-2026')).status, 403, "another state's data stays locked");
  }
  const cfg = (await browser()('/api/config')).json;
  assert.deepEqual(cfg.meritByName, ['Tamil Nadu'], 'Tamil Nadu prints no NEET-PG ranks: its CMR is found by name');
});

test('Odisha allotment; Kerala, Maharashtra, Karnataka, Madhya Pradesh, Gujarat and Rajasthan data: as printed', async () => {
  const sum = rows => rows.reduce((n, r) => n + r.seats, 0);
  const STATES = [
    // state, key, merit lists, seats, allotted
    ['Odisha', 'odisha', null, 463, 374],
    ['Kerala', 'kerala', [['State merit list', 5665], ['Second list (not qualified)', 20]], 1173 + 17, 1082],
    ['Maharashtra', 'maharashtra', [['State merit list', 7242], ['In-service (20% quota)', 65]], 2759, 2112],
    ['Karnataka', 'karnataka', null, 4892, 3272],
    ['Madhya Pradesh', 'madhya-pradesh', [['State common merit list', 4777]], 728 + 1413 + 2 + 26, 1110],
    ['Gujarat', 'gujarat', [['General merit list', 6095], ['In-service merit lists', 12], ['NRI merit list', 39], ['PwD merit list', 13]], 2675 + 13, 2329],
    ['Rajasthan', 'rajasthan', [['State merit list', 3165]], 990 + 1444 + 139, 1366]
  ];
  // one account (sign-up codes are rate-limited per address), its state switched in the profile
  const b = browser(), phone = '9000000300';
  await b('/api/auth/otp/request', { method: 'POST', body: { ...signUp, phone } });
  await b('/api/auth/otp/verify', { method: 'POST', body: { channel: 'phone', phone, code: '1234', password: PW } });
  for (const [state, key, lists, seats, allotted] of STATES) {
    assert.equal((await b('/api/me', { method: 'PATCH', body: { state } })).json.user.state, state);
    if (lists) {
      const merit = (await b(`/api/regions/${key}/data/merit-list-2026`)).json;
      for (const [label, n] of lists) assert.equal(merit.lists.find(l => l.label === label)?.rows.length, n, `${state}: ${label}`);
    }
    assert.equal(sum((await b(`/api/regions/${key}/data/seat-matrix-round-1`)).json.rows), seats, `${state}: seats`);
    if (allotted) {
      const a = (await b(`/api/regions/${key}/data/allotment-round-1`)).json;
      assert.equal(a.format, 'state');
      assert.equal(a.rows.length, allotted, `${state}: allotted`);
      if (key === 'odisha') {
        // every MD/MS seat of the revised matrix is either allotted or listed as vacant
        const md = a.rows.filter(r => r.programme === 'MD/MS').length + sum(a.vacant.filter(v => v.programme === 'MD/MS'));
        assert.equal(md, seats, 'Odisha: allotted + vacant = the MD/MS seat matrix');
      }
      // no college and course allotted more seats than the seat matrix has (Maharashtra and Madhya Pradesh match it name for name)
      if (key === 'maharashtra' || key === 'madhya-pradesh') {
        const cap = new Map(), got = new Map(), k = r => `${r.college}|${r.course}`;
        for (const r of (await b(`/api/regions/${key}/data/seat-matrix-round-1`)).json.rows) cap.set(k(r), (cap.get(k(r)) || 0) + r.seats);
        for (const r of a.rows) got.set(k(r), (got.get(k(r)) || 0) + 1);
        assert.deepEqual([...got].filter(([x, n]) => n > (cap.get(x) || 0)), [], `${state}: allotments within the seat matrix`);
      }
      if (key === 'karnataka') assert.ok(a.rows.every(r => r.fee > 0), 'Karnataka: every allotment carries its course fee');
    }
    assert.equal((await b(`/api/regions/${key === 'odisha' ? 'kerala' : 'odisha'}/data/seat-matrix-round-1`)).status, 403, "another state's data stays locked");
  }
});

test('review access: the admin, and accounts in FULL_ACCESS_PHONES, open every state’s data', async () => {
  // (a candidate's own-state-only access is tested above)
  // the admin, signed in at /admin, with no candidate account
  const a = browser();
  assert.equal((await a('/api/regions/kerala/data/allotment-round-1')).status, 401);
  await a('/api/admin/login', { method: 'POST', body: { password: 'test-pw' } });
  const info = (await a('/api/regions/madhya-pradesh')).json;
  assert.deepEqual([info.access, info.review], ['open', 'admin']);
  for (const key of ['kerala', 'madhya-pradesh', 'maharashtra', 'karnataka', 'tamil-nadu'])
    assert.equal((await a(`/api/regions/${key}/data/allotment-round-1`)).status, 200, `admin: ${key}`);
  // a review account: the Odisha account of the "Keep me logged in" test, whose number is in FULL_ACCESS_PHONES
  // (written there as +91 90000 00113); signed in by password, as sign-up codes are rate-limited per address
  const r = browser();
  assert.equal((await r('/api/auth/password', { method: 'POST', body: { channel: 'phone', phone: '9000000113', password: PW } })).status, 200);
  const rinfo = (await r('/api/regions/uttar-pradesh')).json;
  assert.deepEqual([rinfo.access, rinfo.review], ['open', 'account']);
  assert.equal((await r('/api/regions/uttar-pradesh/data/merit-list-2026')).status, 200);
});

test('the seat matrix of India: NMC’s 6 Nov matrix, for signed-in candidates; a health check for uptime pings', async () => {
  const v = browser();
  assert.equal((await v('/api/seat-matrix')).status, 401);
  assert.equal((await v('/seats')).status, 200, 'the page itself loads (and shows the sign-up gate)');
  const h = await v('/healthz');
  assert.deepEqual([h.status, h.text], [200, 'ok']);
  const r = browser();
  assert.equal((await r('/api/auth/password', { method: 'POST', body: { channel: 'phone', phone: '9000000113', password: PW } })).status, 200);
  const d = (await r('/api/seat-matrix')).json;
  assert.equal(d.rows.length, 10476, 'every row of the NMC matrix');
  assert.equal(d.rows.reduce((n, x) => n + x[2], 0), 68305);
  const states = new Set(d.colleges.map(c => c[2]));
  assert.equal(states.size, 33);
  assert.ok(!states.has('Orissa') && states.has('Odisha'), 'old state spellings merged');
  const seats = t => d.rows.filter(x => d.colleges[x[0]][3] === t).reduce((n, x) => n + x[2], 0);
  assert.deepEqual([seats('Government'), seats('Private'), seats('Deemed')], [34473, 24732, 9100]);
});

test('sign-up asks for the NEET-PG rank; the state CMR is separate, saved later and cleared', async () => {
  const b = browser();
  const noRank = await b('/api/auth/attempt', { method: 'POST', body: { channel: 'phone', phone: '9000000140', name: 'No Rank', state: 'Odisha' } });
  assert.equal(noRank.status, 400);
  assert.match(noRank.json.error, /NEET-PG rank/);
  await b('/api/auth/otp/request', { method: 'POST', body: { ...signUp, phone: '9000000140' } });
  const v = await b('/api/auth/otp/verify', { method: 'POST', body: { channel: 'phone', phone: '9000000140', code: '1234', password: PW } });
  assert.equal(v.json.user.air, 15920);
  assert.equal(v.json.user.cmr, null, 'no state CMR until it is known');
  const set = await b('/api/me', { method: 'PATCH', body: { cmr: 57 } });
  assert.equal(set.status, 200);
  assert.deepEqual([set.json.user.air, set.json.user.cmr], [15920, 57]);
  const clear = await b('/api/me', { method: 'PATCH', body: { cmr: null } });
  assert.deepEqual([clear.json.user.air, clear.json.user.cmr], [15920, null]);
  assert.equal((await b('/api/me', { method: 'PATCH', body: { air: '' } })).status, 200, 'an empty field leaves the rank as it was');
  assert.equal((await b('/api/me', { method: 'PATCH', body: { air: 'abc' } })).status, 400);
});
