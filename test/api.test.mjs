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

test('guides: index data, pages, redirects and assets', async () => {
  const b = browser();
  const g = await b('/api/guides');
  assert.equal(g.status, 200);
  assert.ok(g.json.guides.length >= 13 && g.json.compare.rows.length);
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
  const v = await student('/api/auth/otp/verify', { method: 'POST', body: { channel: 'phone', phone: '9000000101', code: '1234' } });
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
  await b('/api/auth/otp/verify', { method: 'POST', body: { channel: 'phone', phone: '9000000104', code: '1234' } });
  assert.ok((await b('/api/me')).json.user);
  const out = await b('/api/auth/logout', { method: 'POST', headers: { 'content-length': '0' } });
  assert.equal(out.status, 200);
  assert.equal((await b('/api/me')).json.user, null);
});

test('cross-site form posts are still refused', async () => {
  const r = await fetch(BASE + '/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
  assert.equal(r.status, 415);
});
