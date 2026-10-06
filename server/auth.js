import crypto from 'node:crypto';
import { db, now } from './db.js';

const PROD = process.env.NODE_ENV === 'production';
export const PROVIDER = (process.env.AUTH_PROVIDER || 'mock').toLowerCase();
const MOCK_OTP = process.env.MOCK_OTP || '1234';
export const OTP_LENGTH = PROVIDER === 'firebase' ? 6 : MOCK_OTP.length;
const USER_TTL = 30 * 24 * 3600e3;
const ADMIN_TTL = 12 * 3600e3;
const OTP_TTL = 10 * 60e3;

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

export const publicUser = u => u && ({ id: u.id, name: u.name, phone: u.phone, since: u.created_at });

// ---- phone numbers -----------------------------------------------------
/** Indian mobile numbers only, stored as +91XXXXXXXXXX. */
export function normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d)) throw new HttpError(400, 'Enter a valid 10-digit Indian mobile number.');
  return '+91' + d;
}
const cleanName = n => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 80);

function signIn(res, phone, name) {
  const t = now();
  let u = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  const isNew = !u;
  if (isNew) {
    db.prepare('INSERT INTO users (phone, name, created_at, last_seen_at, logins) VALUES (?, ?, ?, ?, 1)').run(phone, name, t, t);
  } else {
    db.prepare('UPDATE users SET logins = logins + 1, last_seen_at = ?, name = CASE WHEN ? <> \'\' THEN ? ELSE name END WHERE id = ?')
      .run(t, name, name, u.id);
  }
  u = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  createSession(res, 'user', u.id);
  return { user: u, isNew };
}

// ---- OTP: mock provider ------------------------------------------------
export function requestOtp(req, { phone: rawPhone, name: rawName }) {
  if (PROVIDER !== 'mock') throw new HttpError(400, 'OTP is sent by the sign-in provider on this server.');
  const phone = normPhone(rawPhone);
  const name = cleanName(rawName);
  if (name.length < 2) throw new HttpError(400, 'Enter your name.');
  limit('otp-ip:' + req.ip, 20, 3600e3);
  limit('otp-phone:' + phone, 5, 3600e3);
  limit('otp-phone-burst:' + phone, 1, 25e3);
  const code = MOCK_OTP; // a real provider would generate and send a random code here
  db.prepare('INSERT INTO otp_requests (phone, code_hash, name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(phone, sha(phone + ':' + code), name, now(), now() + OTP_TTL);
  return { phone, expiresIn: OTP_TTL / 1000 };
}

export function verifyOtp(req, res, { phone: rawPhone, code }) {
  if (PROVIDER !== 'mock') throw new HttpError(400, 'Use the sign-in provider configured on this server.');
  const phone = normPhone(rawPhone);
  limit('verify-ip:' + req.ip, 30, 3600e3);
  const r = db.prepare('SELECT * FROM otp_requests WHERE phone = ? AND used = 0 ORDER BY id DESC LIMIT 1').get(phone);
  if (!r || r.expires_at < now()) throw new HttpError(400, 'That code has expired. Request a new one.');
  if (r.attempts >= 5) throw new HttpError(429, 'Too many wrong codes. Request a new one.');
  const ok = crypto.timingSafeEqual(Buffer.from(sha(phone + ':' + String(code || '').trim())), Buffer.from(r.code_hash));
  if (!ok) {
    db.prepare('UPDATE otp_requests SET attempts = attempts + 1 WHERE id = ?').run(r.id);
    throw new HttpError(400, `Incorrect code. ${4 - r.attempts} attempt${4 - r.attempts === 1 ? '' : 's'} left.`);
  }
  db.prepare('UPDATE otp_requests SET used = 1 WHERE id = ?').run(r.id);
  return signIn(res, phone, r.name);
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

export async function firebaseSignIn(req, res, { idToken, name }) {
  if (PROVIDER !== 'firebase') throw new HttpError(400, 'Firebase sign-in is not enabled.');
  limit('fb-ip:' + req.ip, 30, 3600e3);
  const claims = await verifyFirebaseToken(idToken);
  return signIn(res, normPhone(claims.phone_number), cleanName(name));
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
