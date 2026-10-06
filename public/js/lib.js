// Shared helpers for the public app and the admin console.

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = n => (n === null || n === undefined || n === '' || Number.isNaN(+n)) ? '—' : Number(n).toLocaleString('en-IN');
export const compact = n => n >= 1e5 ? (n / 1e5).toFixed(n >= 1e6 ? 0 : 1).replace(/\.0$/, '') + 'L'
  : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(n);
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const uniq = list => [...new Set(list)].filter(v => v !== '' && v != null);

export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }
};

export async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, opts); }
  catch { throw Object.assign(new Error('You appear to be offline. Check your connection.'), { status: 0 }); }
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

// ---- analytics beacon --------------------------------------------------
let queue = [], timer = null;
function flush() {
  timer = null;
  if (!queue.length) return;
  const body = JSON.stringify({ events: queue.splice(0, 20) });
  const blob = new Blob([body], { type: 'application/json' });
  if (!(navigator.sendBeacon && navigator.sendBeacon('/api/events', blob)))
    fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
}
export function track(type, props = {}) {
  queue.push({ type, props, path: location.pathname, referrer: document.referrer });
  if (!timer) timer = setTimeout(flush, 800);
}
addEventListener('pagehide', flush);

// ---- toast -------------------------------------------------------------
let toastEl, toastT;
export function toast(msg, err = false) {
  toastEl?.remove();
  toastEl = document.createElement('div');
  toastEl.className = 'toast' + (err ? ' err' : '');
  toastEl.setAttribute('role', 'status');
  toastEl.textContent = msg;
  document.body.append(toastEl);
  clearTimeout(toastT);
  toastT = setTimeout(() => toastEl?.remove(), err ? 5000 : 2600);
}

// ---- overlays ----------------------------------------------------------
const stack = [];
addEventListener('keydown', e => { if (e.key === 'Escape' && stack.length) stack[stack.length - 1].close(); });

function overlay(cls, html, onClose) {
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  const box = document.createElement('div');
  box.className = cls;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.innerHTML = html;
  const prev = document.activeElement;
  const h = {
    el: box,
    close() {
      const i = stack.indexOf(h);
      if (i < 0) return;
      stack.splice(i, 1);
      scrim.remove(); box.remove();
      if (!stack.length) document.body.style.overflow = '';
      onClose?.();
      prev?.focus?.();
    }
  };
  scrim.addEventListener('click', h.close);
  box.addEventListener('click', e => { if (e.target.closest('[data-close]')) h.close(); });
  document.body.append(scrim, box);
  document.body.style.overflow = 'hidden';
  stack.push(h);
  // Dialogs focus their first field; drawers focus themselves so they open scrolled to the top.
  box.tabIndex = -1;
  requestAnimationFrame(() => {
    const target = cls === 'drawer' ? box : (box.querySelector('[autofocus]') || box.querySelector('input,select,button:not([data-close])') || box);
    target.focus({ preventScroll: true });
  });
  return h;
}
export const openDialog = (html, { wide = false, onClose } = {}) => overlay('dialog' + (wide ? ' dialog-wide' : ''), html, onClose);
export const openDrawer = (html, { onClose } = {}) => overlay('drawer', html, onClose);

export function confirmDialog(title, message, { ok = 'Confirm', danger = false } = {}) {
  return new Promise(resolve => {
    let done = false;
    const d = openDialog(`
      <div class="dialog-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">${icon.x}</button></div>
      <div class="dialog-body"><p style="margin:0;color:var(--ink-2);line-height:1.6">${message}</p></div>
      <div class="dialog-foot"><button class="btn btn-line" data-close>Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(ok)}</button></div>`,
      { onClose: () => { if (!done) resolve(false); } });
    d.el.querySelector('[data-ok]').addEventListener('click', () => { done = true; d.close(); resolve(true); });
  });
}

// ---- files -------------------------------------------------------------
const cell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export function downloadCsv(name, head, rows) {
  const text = '﻿' + [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---- theme -------------------------------------------------------------
export function initTheme() {
  const t = store.get('rr-theme', null);
  if (t) document.documentElement.dataset.theme = t;
}
export function toggleTheme() {
  const cur = document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('rr-theme', next);
}

// ---- dates -------------------------------------------------------------
export const dateIN = ms => ms ? new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
export const dateTimeIN = ms => ms ? new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';
export function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + ' d ago';
  return dateIN(ms);
}

// ---- icons (1.5px strokes, square caps) ----------------------------------
const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" ${extra} aria-hidden="true">${d}</svg>`;
export const icon = {
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  star: svg('<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8 6.8 19.6l1-5.8-4.3-4.1 5.9-.8z" stroke-linejoin="miter"/>'),
  starFill: svg('<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8 6.8 19.6l1-5.8-4.3-4.1 5.9-.8z" fill="currentColor" stroke-linejoin="miter"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
  download: svg('<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>'),
  upload: svg('<path d="M12 20V9M7 13.5l5-5 5 5M5 4h14"/>'),
  print: svg('<path d="M7 9V4h10v5M7 17H4v-7h16v7h-3M7 14h10v6H7z"/>'),
  up: svg('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  down: svg('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: svg('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
  logout: svg('<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6"/>'),
  chat: svg('<path d="M4 5h16v11H9l-5 4z"/>'),
  filter: svg('<path d="M4 6h16M7 12h10M10 18h4"/>'),
  arrowR: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  ext: svg('<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>'),
  refresh: svg('<path d="M20 11a8 8 0 0 0-14.5-4.5M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5M20 20v-4h-4"/>')
};
