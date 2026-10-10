// First-party traffic analytics. No third-party scripts: the browser posts
// small events to /api/events and the server adds visitor, user and device.
import crypto from 'node:crypto';
import { db, now } from './db.js';
import { cookies, setCookie, limit } from './auth.js';

const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|curl|wget|python|httpclient/i;
const TYPES = new Set(['pageview', 'predict', 'search', 'seat_view', 'shortlist_add', 'export', 'contact_click', 'signin_open']);
const IST = 19800; // +05:30 in seconds — days are bucketed in Indian time

export function device(ua = '') {
  if (BOT.test(ua)) return 'bot';
  if (/iPad|Tablet/i.test(ua)) return 'Tablet';
  if (/Mobi|Android|iPhone/i.test(ua)) return 'Mobile';
  return 'Desktop';
}

/** Sets a long-lived anonymous visitor cookie; exposes req.vid. */
export function visitor(req, res, next) {
  let vid = cookies(req).rr_vid;
  if (!vid || !/^[\w-]{16,40}$/.test(vid)) {
    vid = crypto.randomBytes(12).toString('base64url');
    setCookie(res, 'rr_vid', vid, 400 * 24 * 3600e3);
  }
  req.vid = vid;
  next();
}

export function record(req, type, props = {}, extra = {}) {
  const dev = device(req.headers['user-agent']);
  if (dev === 'bot') return;
  db.prepare('INSERT INTO events (ts, visitor_id, user_id, type, path, referrer, device, props) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(now(), req.vid || 'server', req.user?.id ?? extra.userId ?? null, type,
      String(extra.path || '').slice(0, 200), String(extra.referrer || '').slice(0, 200), dev,
      JSON.stringify(props).slice(0, 2000));
}

function refHost(ref, req) {
  try {
    const u = new URL(ref);
    if (u.host === req.headers.host) return '';
    return u.host.replace(/^www\./, '');
  } catch { return ''; }
}

/** POST /api/events — accepts one event or {events:[...]} from the browser. */
export function ingest(req, res) {
  try { limit('ev:' + req.vid, 240, 60e3); } catch { return res.status(204).end(); }
  const list = Array.isArray(req.body?.events) ? req.body.events.slice(0, 20) : [req.body];
  for (const e of list) {
    if (!e || !TYPES.has(e.type)) continue;
    const props = e.props && typeof e.props === 'object' ? e.props : {};
    record(req, e.type, props, { path: e.path, referrer: refHost(e.referrer, req) });
  }
  res.status(204).end();
}

// ---- dashboard ---------------------------------------------------------
const day = col => `date((${col} / 1000) + ${IST}, 'unixepoch')`;

function bucketize(values, edges, fmt) {
  const out = edges.map((e, i) => ({ label: fmt(e, edges[i + 1]), count: 0 }));
  for (const v of values) {
    let i = edges.length - 1;
    while (i > 0 && v < edges[i]) i--;
    out[i].count++;
  }
  return out;
}
const k = n => n >= 1000 ? (n / 1000) + 'k' : String(n);

export function dashboard(days) {
  const t = now();
  const from = t - days * 86400e3, prevFrom = from - days * 86400e3;

  const kpi = (a, b) => {
    const q = sql => db.prepare(sql).get(a, b).n;
    return {
      visitors: q("SELECT COUNT(DISTINCT visitor_id) n FROM events WHERE type='pageview' AND ts >= ? AND ts < ?"),
      pageviews: q("SELECT COUNT(*) n FROM events WHERE type='pageview' AND ts >= ? AND ts < ?"),
      signups: q('SELECT COUNT(*) n FROM users WHERE created_at >= ? AND created_at < ?'),
      signins: q("SELECT COUNT(*) n FROM events WHERE type='login' AND ts >= ? AND ts < ?"),
      predictions: q("SELECT COUNT(*) n FROM events WHERE type='predict' AND ts >= ? AND ts < ?"),
      otpRequested: q("SELECT COUNT(*) n FROM events WHERE type='otp_request' AND ts >= ? AND ts < ?"),
      otpVerified: q("SELECT COUNT(*) n FROM events WHERE type='login' AND ts >= ? AND ts < ?")
    };
  };

  // one row per IST day, zero-filled
  const series = [];
  const rows = db.prepare(`SELECT ${day('ts')} d,
      COUNT(DISTINCT CASE WHEN type='pageview' THEN visitor_id END) visitors,
      SUM(type='pageview') pageviews, SUM(type='predict') predictions, SUM(type='login') signins
    FROM events WHERE ts >= ? GROUP BY d`).all(from);
  const su = db.prepare(`SELECT ${day('created_at')} d, COUNT(*) n FROM users WHERE created_at >= ? GROUP BY d`).all(from);
  const byDay = new Map(rows.map(r => [r.d, r]));
  const suDay = new Map(su.map(r => [r.d, r.n]));
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(t + IST * 1000 - i * 86400e3).toISOString().slice(0, 10);
    const r = byDay.get(d) || {};
    series.push({ date: d, visitors: r.visitors || 0, pageviews: r.pageviews || 0,
      predictions: r.predictions || 0, signins: r.signins || 0, signups: suDay.get(d) || 0 });
  }

  const distinct = type => db.prepare('SELECT COUNT(DISTINCT visitor_id) n FROM events WHERE type = ? AND ts >= ?').get(type, from).n;
  const funnel = [
    { label: 'Visited', count: distinct('pageview') },
    { label: 'Opened sign-in', count: distinct('signin_open') },
    { label: 'Requested OTP', count: distinct('otp_request') },
    { label: 'Signed in', count: distinct('login') },
    { label: 'Ran a prediction', count: distinct('predict') }
  ];

  const top = (sql, n = 8) => db.prepare(sql + ` LIMIT ${n}`).all(from);
  const interest = top(`SELECT json_extract(props,'$.spec') label, COUNT(*) count FROM events
      WHERE type IN ('seat_view','shortlist_add','predict','search') AND ts >= ? AND COALESCE(json_extract(props,'$.spec'),'') <> ''
      GROUP BY label ORDER BY count DESC`, 10);
  const colleges = top(`SELECT json_extract(props,'$.college') label, COUNT(*) count FROM events
      WHERE type IN ('seat_view','shortlist_add') AND ts >= ? AND COALESCE(json_extract(props,'$.college'),'') <> ''
      GROUP BY label ORDER BY count DESC`, 10);
  const categories = top(`SELECT COALESCE(NULLIF(json_extract(props,'$.category'),''),'Not chosen') label, COUNT(*) count
      FROM events WHERE type='predict' AND ts >= ? GROUP BY label ORDER BY count DESC`);
  const devices = top(`SELECT device label, COUNT(DISTINCT visitor_id) count FROM events WHERE ts >= ? AND type='pageview' GROUP BY device ORDER BY count DESC`);
  const referrers = top(`SELECT COALESCE(NULLIF(referrer,''),'Direct / none') label, COUNT(DISTINCT visitor_id) count
      FROM events WHERE type='pageview' AND ts >= ? GROUP BY label ORDER BY count DESC`);
  const pages = top(`SELECT path label, COUNT(*) count FROM events WHERE type='pageview' AND ts >= ? GROUP BY path ORDER BY count DESC`);
  const states = top(`SELECT COALESCE(NULLIF(state,''),'Not given') label, COUNT(*) count FROM users
      WHERE created_at >= ? GROUP BY label ORDER BY count DESC`, 12);
  const channels = top(`SELECT CASE WHEN phone IS NOT NULL THEN 'Mobile' ELSE 'Email' END label, COUNT(*) count FROM users
      WHERE created_at >= ? GROUP BY label ORDER BY count DESC`);

  const ranks = scope => db.prepare(`SELECT CAST(json_extract(props,'$.rank') AS INTEGER) r FROM events
      WHERE type='predict' AND ts >= ? AND json_extract(props,'$.scope') = ?`).all(from, scope).map(x => x.r).filter(r => r > 0);
  const cmr = bucketize(ranks('state'), [1, 100, 250, 500, 750, 1000],
    (a, b) => b ? `${a === 1 ? 1 : a}–${b - 1}` : `${a}+`);
  const air = bucketize(ranks('aiq'), [1, 5000, 10000, 25000, 50000, 100000],
    (a, b) => b ? `${a === 1 ? '<' + k(b) : k(a) + '–' + k(b)}` : `${k(a)}+`);

  return {
    days, generatedAt: t,
    kpi: kpi(from, t), prev: kpi(prevFrom, from),
    live: db.prepare("SELECT COUNT(DISTINCT visitor_id) n FROM events WHERE ts >= ?").get(t - 5 * 60e3).n,
    series, funnel, interest, colleges, categories, devices, referrers, pages, states, channels, cmr, air,
    totals: {
      users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
      events: db.prepare('SELECT COUNT(*) n FROM events').get().n
    }
  };
}
