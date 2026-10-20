import crypto from 'node:crypto';
import { db, now, getSettings } from './db.js';
import { normState } from './states.js';

const PROD = process.env.NODE_ENV === 'production';
export const PROVIDER = (process.env.AUTH_PROVIDER || 'mock').toLowerCase();
const MOCK_OTP = process.env.MOCK_OTP || '1234';
export const OTP_LENGTH = PROVIDER === 'firebase' ? 6 : MOCK_OTP.length;
const USER_TTL = 30 * 24 * 3600e3;
const ADMIN_TTL = 12 * 3600e3;
const OTP_TTL = 10 * 60e3;

// Email codes: always on in mock mode; for real sends, set BREVO_API_KEY and EMAIL_FROM.
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || '';
export const EMAIL_ENABLED = PROVIDER === 'mock' || !!(BREVO_API_KEY && EMAIL_FROM);

export const FIREBASE = {
  apiKey: process.env.FIREBASE_API_KEY || '',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
  projectId: process.env.FIREBASE_PROJECT_ID || '',
  appId: process.env.FIREBASE_APP_ID || ''
};

if (PROVIDER === 'mock' && PROD)
  console.warn(`[auth] WARNING: AUTH_PROVIDER=mock in production — every phone signs in with ${MOCK_OTP}.`);
if (PROVIDER === 'firebase' && !FIREBASE.projectId)
  console.warn('[auth] WARNING: AUTH_PROVIDER=firebase but FIREBASE_PROJECT_ID is not set.');
if (PROVIDER !== 'mock' && !EMAIL_ENABLED)
  console.warn('[auth] Email sign-in is off: set BREVO_API_KEY and EMAIL_FROM to send email codes.');
if (!process.env.ADMIN_PASSWORD)
  console.warn('[auth] WARNING: ADMIN_PASSWORD is not set — admin sign-in is disabled.');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---- tiny in-memory rate limiter ---------------------------------------
const hits = new Map();
export function limit(key, max, windowMs) {
  const t = now();
  const list = (hits.get(key) || []).filter(x => t - x < windowMs);
  if (list.length >= max) {
    const wait = Math.ceil((windowMs - (t - list[0])) / 1000);
    throw new HttpError(429, `Too many attempts. Try again in ${wait > 90 ? Math.ceil(wait / 60) + ' minutes' : wait + ' seconds'}.`);
  }
  list.push(t);
  hits.set(key, list);
}
setInterval(() => { const t = now(); for (const [k, v] of hits) if (!v.some(x => t - x < 3600e3)) hits.delete(k); }, 600e3).unref();

// ---- cookies + sessions ------------------------------------------------
export function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function setCookie(res, name, value, maxAgeMs) {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (PROD) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

function createSession(res, role, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ttl = role === 'admin' ? ADMIN_TTL : USER_TTL;
  db.prepare('INSERT INTO sessions (token_hash, user_id, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha(token), userId ?? null, role, now(), now() + ttl);
  setCookie(res, role === 'admin' ? 'rr_admin' : 'rr_sid', token, ttl);
}
function readSession(req, cookie, role) {
  const token = cookies(req)[cookie];
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND role = ?').get(sha(token), role);
  if (!s || s.expires_at < now()) return null;
  return s;
}
export function endSession(req, res, role) {
  const cookie = role === 'admin' ? 'rr_admin' : 'rr_sid';
  const token = cookies(req)[cookie];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  setCookie(res, cookie, '', 0);
}
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now()), 3600e3).unref();

/** Attaches req.user (or null) for every request. */
export function attachUser(req, _res, next) {
  const s = readSession(req, 'rr_sid', 'user');
  req.user = s ? db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id) : null;
  if (req.user && now() - req.user.last_seen_at > 5 * 60e3)
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), req.user.id);
  next();
}
export function requireUser(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in to continue.'));
  next();
}
export function requireAdmin(req, _res, next) {
  if (!readSession(req, 'rr_admin', 'admin')) return next(new HttpError(401, 'Admin sign-in required.'));
  next();
}
export const isAdmin = req => !!readSession(req, 'rr_admin', 'admin');

export const publicUser = u => u && ({
  id: u.id, name: u.name, phone: u.phone, email: u.email, cmr: u.cmr, state: u.state, since: u.created_at
});

// ---- contact details + profile -----------------------------------------
/** Indian mobile numbers only, stored as +91XXXXXXXXXX. */
export function normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d)) throw new HttpError(400, 'Enter a valid 10-digit Indian mobile number.');
  return '+91' + d;
}
export function normEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e)) throw new HttpError(400, 'Enter a valid email address.');
  return e;
}
/** { channel: 'phone' | 'email', contact } from a request body. */
function readContact(b) {
  const channel = b.channel === 'email' ? 'email' : 'phone';
  return { channel, contact: channel === 'email' ? normEmail(b.email) : normPhone(b.phone) };
}
const cleanName = n => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 80);

/**
 * Name, NEET-PG CMR and state from a request body. Fields left out stay out
 * of the result; with `required` all three must be given (sign-up).
 */
export function readProfile(b = {}, required = false) {
  const out = {};
  if (b.name !== undefined && b.name !== '') {
    out.name = cleanName(b.name);
    if (out.name.length < 2) throw new HttpError(400, 'Enter your name.');
  }
  if (b.cmr !== undefined && b.cmr !== '' && b.cmr !== null) {
    const n = Number(String(b.cmr).replace(/[\s,]/g, ''));
    if (!Number.isInteger(n) || n < 1 || n > 500000) throw new HttpError(400, 'Enter your NEET-PG CMR as a whole number.');
    out.cmr = n;
  }
  if (b.state !== undefined && b.state !== '') {
    out.state = normState(b.state);
    if (!out.state) throw new HttpError(400, 'Choose your state from the list.');
  }
  if (required) {
    if (!out.name) throw new HttpError(400, 'Enter your name.');
    if (!out.cmr) throw new HttpError(400, 'Enter your NEET-PG CMR.');
    if (!out.state) throw new HttpError(400, 'Choose your state.');
  }
  return out;
}

function signIn(res, { channel, contact }, profile) {
  const t = now();
  const find = () => db.prepare(`SELECT * FROM users WHERE ${channel} = ?`).get(contact);
  let u = find();
  const isNew = !u;
  if (isNew) {
    db.prepare(`INSERT INTO users (${channel}, name, cmr, state, created_at, last_seen_at, logins) VALUES (?, ?, ?, ?, ?, ?, 1)`)
      .run(contact, profile.name || '', profile.cmr ?? null, profile.state || '', t, t);
  } else {
    // Signing up again with the same contact refreshes the details given.
    db.prepare(`UPDATE users SET logins = logins + 1, last_seen_at = ?,
        name = COALESCE(?, name), cmr = COALESCE(?, cmr), state = COALESCE(?, state) WHERE id = ?`)
      .run(t, profile.name ?? null, profile.cmr ?? null, profile.state ?? null, u.id);
  }
  u = find();
  db.prepare('UPDATE signup_attempts SET verified_at = ? WHERE contact = ? AND verified_at IS NULL').run(t, contact);
  createSession(res, 'user', u.id);
  return { user: u, isNew };
}

// ---- sign-up attempts ----------------------------------------------------
/**
 * Keeps a sign-up's details as soon as a code is requested (and the error, if sending
 * fails), so the lead isn't lost when the code never arrives. One open row per contact a day.
 */
export function saveAttempt(req, body) {
  const { channel, contact } = readContact(body);
  const p = readProfile(body, true);
  const error = String(body.error || '').replace(/[^\w.-]/g, '').slice(0, 60);
  limit('attempt-ip:' + req.ip, 30, 3600e3);
  const t = now();
  const open = db.prepare('SELECT id FROM signup_attempts WHERE contact = ? AND verified_at IS NULL AND created_at > ? ORDER BY id DESC LIMIT 1')
    .get(contact, t - 86400e3);
  if (open) db.prepare(`UPDATE signup_attempts SET name = ?, cmr = ?, state = ?, error = CASE WHEN ? <> '' THEN ? ELSE error END, updated_at = ?
      WHERE id = ?`).run(p.name, p.cmr, p.state, error, error, t, open.id);
  else db.prepare('INSERT INTO signup_attempts (contact, channel, name, cmr, state, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(contact, channel, p.name, p.cmr, p.state, error, t, t);
  return { channel };
}

// ---- Firebase set-up check ----------------------------------------------
// Firebase accepts phone sign-in only from the project's Authorized domains. When this
// site's address is missing there, every code request fails with captcha-check-failed.
const domainChecks = new Map(); // host -> { at, result }
const checking = new Map();     // host -> in-flight check, so concurrent requests share one

/** { host, authorized: true | false | null, domains?, error? } for this site address. Cached. */
export function firebaseDomainStatus(host) {
  if (PROVIDER !== 'firebase') return Promise.resolve(null);
  const hit = domainChecks.get(host);
  if (hit && now() - hit.at < (hit.result.authorized === false ? 60e3 : 600e3)) return Promise.resolve(hit.result);
  if (!checking.has(host)) checking.set(host, checkDomain(host, hit).finally(() => checking.delete(host)));
  return checking.get(host);
}
async function checkDomain(host, hit) {
  let result;
  try {
    const r = await fetch(`https://www.googleapis.com/identitytoolkit/v3/relyingparty/getProjectConfig?key=${encodeURIComponent(FIREBASE.apiKey)}`,
      { headers: { Referer: `https://${host}/` }, signal: AbortSignal.timeout(6000) });
    const body = await r.json().catch(() => ({}));
    result = r.ok
      ? { host, authorized: (body.authorizedDomains || []).includes(host), domains: body.authorizedDomains || [] }
      : { host, authorized: null, error: body.error?.message || `Google answered ${r.status}` };
  } catch {
    result = { host, authorized: null, error: 'Could not reach Google to check.' };
  }
  if (result.authorized === false && hit?.result.authorized !== false)
    console.warn(`[auth] Firebase: "${host}" is not in Authorized domains, so phone sign-in fails on it.`);
  domainChecks.set(host, { at: now(), result });
  return result;
}

/** False only once Firebase has confirmed this address is not authorized. Never waits on Google. */
export function phoneSignInReady(host) {
  if (PROVIDER !== 'firebase') return true;
  // Health checks and internal calls arrive on bare IP addresses; only check real site names.
  if (!host || (/^[\d.]+$|:/.test(host) && host !== '127.0.0.1')) return true;
  firebaseDomainStatus(host); // refreshes the cache in the background when stale; never rejects
  return domainChecks.get(host)?.result.authorized !== false;
}

// ---- OTP: codes we issue ourselves (mock mode, and email) ---------------
async function sendEmailCode(to, code) {
  const brand = getSettings().brand || 'RankRound';
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: EMAIL_FROM, name: brand },
      to: [{ email: to }],
      subject: `${code} is your ${brand} sign-in code`,
      textContent: `Your ${brand} sign-in code is ${code}. It expires in 10 minutes.\n\nIf you did not ask for this code, you can ignore this email.`
    })
  }).catch(() => null);
  if (!r?.ok) throw new HttpError(502, 'We could not send the email just now. Try again, or use your mobile number.');
}

export async function requestOtp(req, body) {
  const { channel, contact } = readContact(body);
  if (channel === 'phone' && PROVIDER !== 'mock') throw new HttpError(400, 'SMS codes are sent by the sign-in provider on this server.');
  if (channel === 'email' && !EMAIL_ENABLED) throw new HttpError(400, 'Email sign-in is not available yet. Use your mobile number.');
  const profile = readProfile(body, body.mode === 'signup');
  limit('otp-ip:' + req.ip, 20, 3600e3);
  limit('otp-contact:' + contact, 5, 3600e3);
  limit('otp-contact-burst:' + contact, 1, 25e3);
  const code = PROVIDER === 'mock' ? MOCK_OTP : String(crypto.randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
  if (PROVIDER !== 'mock') await sendEmailCode(contact, code);
  db.prepare('INSERT INTO otp_requests (contact, code_hash, profile, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(contact, sha(contact + ':' + code), JSON.stringify(profile), now(), now() + OTP_TTL);
  return { channel, expiresIn: OTP_TTL / 1000 };
}

export function verifyOtp(req, res, body) {
  const { channel, contact } = readContact(body);
  if (channel === 'phone' && PROVIDER !== 'mock') throw new HttpError(400, 'Use the sign-in provider configured on this server.');
  limit('verify-ip:' + req.ip, 30, 3600e3);
  const r = db.prepare('SELECT * FROM otp_requests WHERE contact = ? AND used = 0 ORDER BY id DESC LIMIT 1').get(contact);
  if (!r || r.expires_at < now()) throw new HttpError(400, 'That code has expired. Request a new one.');
  if (r.attempts >= 5) throw new HttpError(429, 'Too many wrong codes. Request a new one.');
  const ok = crypto.timingSafeEqual(Buffer.from(sha(contact + ':' + String(body.code || '').trim())), Buffer.from(r.code_hash));
  if (!ok) {
    db.prepare('UPDATE otp_requests SET attempts = attempts + 1 WHERE id = ?').run(r.id);
    throw new HttpError(400, `Incorrect code. ${4 - r.attempts} attempt${4 - r.attempts === 1 ? '' : 's'} left.`);
  }
  db.prepare('UPDATE otp_requests SET used = 1 WHERE id = ?').run(r.id);
  return signIn(res, { channel, contact }, JSON.parse(r.profile));
}

// ---- OTP: Firebase phone auth ------------------------------------------
// The browser runs Firebase's SMS + reCAPTCHA flow and sends us the ID token.
// We verify it against Google's public keys directly — no service account
// or firebase-admin dependency needed.
let certs = { at: 0, ttl: 0, keys: {} };
async function googleCerts() {
  if (now() - certs.at < certs.ttl) return certs.keys;
  const r = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
  if (!r.ok) throw new HttpError(502, 'Could not reach Google to verify sign-in.');
  const maxAge = Number(/max-age=(\d+)/.exec(r.headers.get('cache-control') || '')?.[1] || 3600);
  certs = { at: now(), ttl: maxAge * 1000, keys: await r.json() };
  return certs.keys;
}
const b64json = s => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

export async function verifyFirebaseToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new HttpError(400, 'Malformed sign-in token.');
  const [h, p, sig] = parts;
  const header = b64json(h), claims = b64json(p);
  if (header.alg !== 'RS256') throw new HttpError(401, 'Unexpected token algorithm.');
  const pem = (await googleCerts())[header.kid];
  if (!pem) throw new HttpError(401, 'Unknown signing key.');
  const key = new crypto.X509Certificate(pem).publicKey;
  if (!crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), key, Buffer.from(sig, 'base64url')))
    throw new HttpError(401, 'Sign-in token signature is invalid.');
  const t = Math.floor(now() / 1000), pid = FIREBASE.projectId;
  if (claims.aud !== pid || claims.iss !== 'https://securetoken.google.com/' + pid) throw new HttpError(401, 'Token is for another project.');
  if (!(claims.exp > t) || !(claims.iat <= t + 60) || !(claims.auth_time <= t + 60) || !claims.sub) throw new HttpError(401, 'Sign-in token has expired.');
  if (!claims.phone_number) throw new HttpError(401, 'Token has no verified phone number.');
  return claims;
}

export async function firebaseSignIn(req, res, body) {
  if (PROVIDER !== 'firebase') throw new HttpError(400, 'Firebase sign-in is not enabled.');
  limit('fb-ip:' + req.ip, 30, 3600e3);
  const profile = readProfile(body, body.mode === 'signup');
  const claims = await verifyFirebaseToken(body.idToken);
  return signIn(res, { channel: 'phone', contact: normPhone(claims.phone_number) }, profile);
}

// ---- admin -------------------------------------------------------------
export function adminLogin(req, res, password) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) throw new HttpError(503, 'Admin sign-in is disabled: ADMIN_PASSWORD is not set on the server.');
  limit('admin-ip:' + req.ip, 10, 15 * 60e3);
  const ok = crypto.timingSafeEqual(Buffer.from(sha(String(password || ''))), Buffer.from(sha(expected)));
  if (!ok) throw new HttpError(401, 'Wrong password.');
  createSession(res, 'admin', null);
}
