import {
  esc, fmt, compact, debounce, $, $$, api, toast, openDialog, openDrawer, confirmDialog, icon, toggleTheme, dateIN, dateTimeIN, ago
} from './lib.js';

const app = $('#app');
const A = { provider: 'mock', states: [], schema: null, days: 30, dash: null };
const SHEETJS = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
const ROWS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 5h18v14H3zM3 10h18M3 15h18M9 5v14"/></svg>';
const KLABEL = { state: 'State counselling', aiq: 'All India Quota' };
const MAIL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 5h18v14H3z"/><path d="m3 6 9 7 9-7"/></svg>';
const stateSelect = (attrs, sel) => `<select class="select" ${attrs}><option value="">Choose a state</option>${A.states.map(s => `<option ${s === sel ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>`;

const nav = {
  overview: ['Overview', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>'],
  leads: ['Leads', icon.user],
  datasets: ['Datasets', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>'],
  settings: ['Settings', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>']
};

// 401 anywhere → back to the login screen
async function call(path, opts) {
  try { return await api(path, opts); }
  catch (e) { if (e.status === 401) { login('Your session ended. Sign in again.'); } throw e; }
}

async function boot() {
  try {
    const me = await api('/api/admin/me');
    A.provider = me.provider;
    A.states = me.states || [];
    me.admin ? shell() : login();
  } catch (e) { app.innerHTML = `<div class="login"><div class="login-card"><header><b>Can't reach the server</b><span>${esc(e.message)}</span></header></div></div>`; }
}

function login(msg) {
  removeEventListener('hashchange', render);
  app.innerHTML = `<div class="login"><div class="login-card">
    <header><b>Rank<em>Round</em></b><span>Admin console — authorised staff only</span></header>
    <form id="lf">
      <label class="field"><span class="label">Password</span><input class="input" type="password" name="pw" autocomplete="current-password" autofocus required></label>
      ${msg ? `<div class="alert alert-err" style="margin-top:14px">${esc(msg)}</div>` : ''}
      <button class="btn btn-primary btn-lg" style="width:100%;margin-top:20px">Sign in</button>
    </form></div></div>`;
  $('#lf input').focus();
  $('#lf').onsubmit = async e => {
    e.preventDefault();
    try { await api('/api/admin/login', { method: 'POST', body: { password: e.target.pw.value } }); shell(); }
    catch (err) { login(err.message); }
  };
}

function shell() {
  app.innerHTML = `<div class="shell">
    <aside class="side">
      <div class="side-brand"><b>Rank<em>Round</em></b><span>Admin console</span></div>
      <nav>${Object.entries(nav).map(([k, [t, i]]) => `<a href="#${k}" data-p="${k}">${i}<span>${t}</span></a>`).join('')}</nav>
      <div class="side-foot">
        <a href="/" target="_blank" rel="noopener">${icon.ext}<span>View site</span></a>
        <button id="thm">${icon.moon}<span>Theme</span></button>
        <button id="out">${icon.logout}<span>Sign out</span></button>
      </div>
    </aside>
    <div class="main">
      ${A.provider === 'mock' ? `<div class="warnbar"><b>Test sign-in mode.</b> No SMS is sent and every number signs in with code 1234.
        Switch to Firebase phone sign-in before launch — see <a href="#settings">Settings</a>.</div>` : ''}
      <div id="page"></div>
    </div></div>`;
  $('#thm').onclick = () => { toggleTheme(); if (A.dash) drawCharts(); };
  $('#out').onclick = async () => { await api('/api/admin/logout', { method: 'POST' }).catch(() => {}); login(); };
  addEventListener('hashchange', render);
  render();
}

function render() {
  const [p, arg] = location.hash.slice(1).split('/');
  const page = nav[p] ? p : 'overview';
  $$('.side nav a').forEach(a => a.dataset.p === page ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  A.dash = null;
  ({ overview, leads, datasets, settings })[page](arg);
}
const head = (eyebrow, title, sub, actions = '') => `
  <div class="mhead"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div>
  <div class="mhead-actions">${actions}</div></div>`;

// =====================================================================
// Charts (hand-drawn SVG: hairline grid, 2px lines, ≤24px bars, hover tips)
// =====================================================================
function niceScale(max, n = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / n, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * p).find(s => s >= raw);
  const out = [];
  for (let v = 0; v < max + step - 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}
const dShort = d => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const dLong = d => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

function tipper(el) {
  let tip = el.querySelector('.tip');
  if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; tip.hidden = true; el.append(tip); }
  return {
    show(x, y, html) { tip.innerHTML = html; tip.hidden = false; tip.style.left = x + 'px'; tip.style.top = y + 'px'; },
    hide() { tip.hidden = true; }
  };
}

function lineChart(el, pts, unit) {
  const W = Math.max(320, el.clientWidth), H = 230, L = 40, R = 14, T = 14, B = 28;
  const ticks = niceScale(Math.max(...pts.map(p => p.v), 1));
  const max = ticks[ticks.length - 1];
  const x = i => L + i * (W - L - R) / Math.max(1, pts.length - 1);
  const y = v => T + (1 - v / max) * (H - T - B);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const area = line + `L${x(pts.length - 1)},${y(0)}L${x(0)},${y(0)}Z`;
  const last = pts[pts.length - 1];
  const xl = [0, Math.floor((pts.length - 1) / 2), pts.length - 1];
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(unit)} per day">
    <g class="axis">${ticks.map(t => `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>
      <text x="${L - 8}" y="${y(t) + 3.5}" text-anchor="end">${compact(t)}</text>`).join('')}
      ${xl.map((i, k) => `<text x="${x(i)}" y="${H - 8}" text-anchor="${['start', 'middle', 'end'][k]}">${dShort(pts[i].d)}</text>`).join('')}</g>
    <line class="baseline" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>
    <path d="${area}" fill="var(--series-wash)"/>
    <path d="${line}" fill="none" stroke="var(--series)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(pts.length - 1)}" cy="${y(last.v)}" r="4.5" fill="var(--series)" stroke="var(--surface)" stroke-width="2"/>
    <g class="hover" visibility="hidden"><line y1="${T}" y2="${y(0)}" stroke="var(--rule-2)"/>
      <circle r="4.5" fill="var(--series)" stroke="var(--surface)" stroke-width="2"/></g>
    <rect x="${L}" y="0" width="${W - L - R}" height="${H - B}" fill="transparent" class="hit"/>
  </svg>`;
  const svg = el.querySelector('svg'), hov = svg.querySelector('.hover'), tip = tipper(el);
  svg.querySelector('.hit').addEventListener('mousemove', e => {
    const r = svg.getBoundingClientRect(), sx = (e.clientX - r.left) * W / r.width;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round((sx - L) / ((W - L - R) / Math.max(1, pts.length - 1)))));
    hov.setAttribute('visibility', 'visible');
    hov.querySelector('line').setAttribute('x1', x(i)); hov.querySelector('line').setAttribute('x2', x(i));
    hov.querySelector('circle').setAttribute('cx', x(i)); hov.querySelector('circle').setAttribute('cy', y(pts[i].v));
    tip.show(x(i) * r.width / W, y(pts[i].v) * r.height / H, `${dLong(pts[i].d)}<br><b>${fmt(pts[i].v)}</b> ${esc(unit)}`);
  });
  svg.querySelector('.hit').addEventListener('mouseleave', () => { hov.setAttribute('visibility', 'hidden'); tip.hide(); });
}

function columnChart(el, data, unit, { height = 170, dates = false } = {}) {
  const W = Math.max(280, el.clientWidth), H = height, L = 34, R = 6, T = 16, B = 26;
  const ticks = niceScale(Math.max(...data.map(d => d.v), 1), 3);
  const max = ticks[ticks.length - 1];
  const band = (W - L - R) / data.length;
  const bw = Math.min(24, Math.max(2, band - 2));
  const y = v => T + (1 - v / max) * (H - T - B);
  const label = d => dates ? dShort(d.l) : d.l;
  const showVal = data.length <= 8;
  const xl = dates ? [0, data.length - 1] : data.map((_, i) => i);
  const bar = (d, i) => {
    const x = L + i * band + (band - bw) / 2, top = y(d.v), h = y(0) - top;
    if (h <= 0) return '';
    const rr = Math.min(4, h, bw / 2);
    return `<path d="M${x},${y(0)}V${top + rr}Q${x},${top} ${x + rr},${top}H${x + bw - rr}Q${x + bw},${top} ${x + bw},${top + rr}V${y(0)}Z" fill="var(--series)"/>`;
  };
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(unit)}">
    <g class="axis">${ticks.map(t => `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>
      <text x="${L - 7}" y="${y(t) + 3.5}" text-anchor="end">${compact(t)}</text>`).join('')}
      ${xl.map(i => `<text x="${L + i * band + band / 2}" y="${H - 8}" text-anchor="${dates ? (i ? 'end' : 'start') : 'middle'}">${esc(label(data[i]))}</text>`).join('')}</g>
    ${data.map(bar).join('')}
    <line class="baseline" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>
    ${showVal ? data.map((d, i) => d.v ? `<text x="${L + i * band + band / 2}" y="${y(d.v) - 5}" text-anchor="middle" style="font:500 10.5px var(--mono);fill:var(--ink-2)">${fmt(d.v)}</text>` : '').join('') : ''}
    ${data.map((d, i) => `<rect x="${L + i * band}" y="${T}" width="${band}" height="${H - T - B}" fill="transparent" data-i="${i}"/>`).join('')}
  </svg>`;
  const svg = el.querySelector('svg'), tip = tipper(el);
  svg.addEventListener('mousemove', e => {
    const i = e.target.dataset?.i;
    if (i === undefined) return tip.hide();
    const d = data[+i], r = svg.getBoundingClientRect();
    tip.show((L + +i * band + band / 2) * r.width / W, y(d.v) * r.height / H, `${esc(dates ? dLong(d.l) : d.l)}<br><b>${fmt(d.v)}</b> ${esc(unit)}`);
  });
  svg.addEventListener('mouseleave', () => tip.hide());
}

function spark(pts) {
  const W = 160, H = 28, max = Math.max(1, ...pts);
  const x = i => i * W / Math.max(1, pts.length - 1), y = v => 3 + (1 - v / max) * (H - 6);
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--faint)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    <circle cx="${x(pts.length - 1)}" cy="${y(pts[pts.length - 1])}" r="2.5" fill="var(--series)"/></svg>`;
}
function barList(rows, { unit = '', pctOf } = {}) {
  if (!rows.length) return '<div class="none">No data in this period yet.</div>';
  const max = Math.max(...rows.map(r => r.count), 1);
  return `<div class="barlist">${rows.map(r => `<div class="bl" title="${esc(r.label)}: ${fmt(r.count)} ${unit}">
    <span>${esc(r.label)}${pctOf ? `<small>${pctOf ? Math.round(100 * r.count / pctOf) + '%' : ''}</small>` : ''}</span><b>${fmt(r.count)}</b>
    <i><em style="width:${(100 * r.count / max).toFixed(1)}%"></em></i></div>`).join('')}</div>`;
}

// =====================================================================
// Overview
// =====================================================================
async function overview() {
  const page = $('#page');
  page.innerHTML = head('Traffic & engagement', 'Overview', 'First-party analytics — no third-party trackers. Days are in Indian Standard Time.',
    `<span class="live" id="live"></span>
     <div class="seg compact" role="group" aria-label="Period">${[7, 30, 90].map(d => `<button data-d="${d}" aria-pressed="${A.days === d}">${d} days</button>`).join('')}</div>
     <button class="icon-btn" id="rf" aria-label="Refresh">${icon.refresh}</button>`) + `<div class="mbody" id="ov"><div class="empty"><span class="spinner"></span></div></div>`;
  $$('[data-d]').forEach(b => b.onclick = () => { A.days = +b.dataset.d; overview(); });
  $('#rf').onclick = overview;
  let d;
  try { d = await call('/api/admin/analytics?days=' + A.days); } catch (e) { $('#ov').innerHTML = `<div class="alert alert-err">${esc(e.message)}</div>`; return; }
  A.dash = d;
  $('#live').innerHTML = `<i></i>${fmt(d.live)} on site now`;
  const delta = (cur, prev) => {
    if (!prev) return cur ? `<b class="up">new</b> vs previous ${d.days} days` : `— vs previous ${d.days} days`;
    const p = Math.round(100 * (cur - prev) / prev);
    return `<b class="${p >= 0 ? 'up' : 'down'}">${p >= 0 ? '▲' : '▼'} ${Math.abs(p)}%</b> vs previous ${d.days} days`;
  };
  const k = d.kpi, pv = d.prev;
  const conv = k.otpRequested ? Math.round(100 * k.otpVerified / k.otpRequested) : null;
  const pconv = pv.otpRequested ? Math.round(100 * pv.otpVerified / pv.otpRequested) : null;
  const tiles = [
    ['Unique visitors', fmt(k.visitors), delta(k.visitors, pv.visitors), d.series.map(s => s.visitors)],
    ['Page views', fmt(k.pageviews), delta(k.pageviews, pv.pageviews), d.series.map(s => s.pageviews)],
    ['New sign-ups', fmt(k.signups), delta(k.signups, pv.signups), d.series.map(s => s.signups)],
    ['Predictions run', fmt(k.predictions), delta(k.predictions, pv.predictions), d.series.map(s => s.predictions)],
    ['OTP completion', conv === null ? '—' : conv + '%', conv === null || pconv === null ? `${fmt(k.otpVerified)} of ${fmt(k.otpRequested)} codes verified`
      : `<b class="${conv >= pconv ? 'up' : 'down'}">${conv >= pconv ? '▲' : '▼'} ${Math.abs(conv - pconv)} pts</b> vs previous`, d.series.map(s => s.signins)]
  ];
  $('#ov').innerHTML = `
    <div class="kpis">${tiles.map(([l, v, dl, s]) => `<div class="kpi"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div>
      <div class="kpi-delta">${dl}</div>${spark(s)}</div>`).join('')}</div>
    <div class="row r21">
      <div class="panel"><div class="panel-head"><h2>Visitors per day</h2><span>unique visitors · last ${d.days} days</span></div>
        <div class="panel-body"><div class="chart" id="c-vis"></div></div></div>
      <div class="panel"><div class="panel-head"><h2>Sign-in funnel</h2><span>unique visitors</span></div>
        <div class="panel-body funnel">${barList(d.funnel, { unit: 'visitors', pctOf: d.funnel[0].count || 0 })}</div></div>
    </div>
    <div class="row r2">
      <div class="panel"><div class="panel-head"><h2>New sign-ups per day</h2><span>${fmt(k.signups)} in period · ${fmt(d.totals.users)} all-time</span></div>
        <div class="panel-body"><div class="chart" id="c-su"></div></div></div>
      <div class="panel"><div class="panel-head"><h2>Predictions per day</h2><span>rank look-ups run</span></div>
        <div class="panel-body"><div class="chart" id="c-pr"></div></div></div>
    </div>
    <div class="row r2">
      <div class="panel"><div class="panel-head"><h2>Sign-ups by state</h2><span>state chosen at sign-up</span></div><div class="panel-body">${barList(d.states, { unit: 'sign-ups' })}</div></div>
      <div class="panel"><div class="panel-head"><h2>Sign-ups by contact</h2><span>mobile or email</span></div><div class="panel-body">${barList(d.channels, { unit: 'sign-ups' })}</div></div>
    </div>
    <div class="row r2">
      <div class="panel"><div class="panel-head"><h2>Ranks searched · state CMR</h2><span>what candidates entered</span></div>
        <div class="panel-body"><div class="chart" id="c-cmr"></div></div></div>
      <div class="panel"><div class="panel-head"><h2>Ranks searched · NEET AIR</h2><span>All India Quota look-ups</span></div>
        <div class="panel-body"><div class="chart" id="c-air"></div></div></div>
    </div>
    <div class="row r3">
      <div class="panel"><div class="panel-head"><h2>Speciality interest</h2><span>views, filters &amp; shortlists</span></div><div class="panel-body">${barList(d.interest)}</div></div>
      <div class="panel"><div class="panel-head"><h2>Colleges viewed</h2><span>seat opens &amp; shortlists</span></div><div class="panel-body">${barList(d.colleges)}</div></div>
      <div class="panel"><div class="panel-head"><h2>Categories</h2><span>chosen in predictions</span></div><div class="panel-body">${barList(d.categories)}</div></div>
    </div>
    <div class="row r3">
      <div class="panel"><div class="panel-head"><h2>Traffic sources</h2><span>referring site</span></div><div class="panel-body">${barList(d.referrers, { unit: 'visitors' })}</div></div>
      <div class="panel"><div class="panel-head"><h2>Devices</h2><span>unique visitors</span></div><div class="panel-body">${barList(d.devices, { unit: 'visitors' })}</div></div>
      <div class="panel"><div class="panel-head"><h2>Pages</h2><span>page views</span></div><div class="panel-body">${barList(d.pages, { unit: 'views' })}</div></div>
    </div>`;
  drawCharts();
}
function drawCharts() {
  const d = A.dash;
  if (!d || !$('#c-vis')) return;
  lineChart($('#c-vis'), d.series.map(s => ({ d: s.date, v: s.visitors })), 'visitors');
  columnChart($('#c-su'), d.series.map(s => ({ l: s.date, v: s.signups })), 'sign-ups', { dates: true });
  columnChart($('#c-pr'), d.series.map(s => ({ l: s.date, v: s.predictions })), 'predictions', { dates: true });
  columnChart($('#c-cmr'), d.cmr.map(b => ({ l: b.label, v: b.count })), 'searches');
  columnChart($('#c-air'), d.air.map(b => ({ l: b.label, v: b.count })), 'searches');
}
addEventListener('resize', debounce(drawCharts, 150));

// =====================================================================
// Leads
// =====================================================================
const lastSearch = l => l.lastRank ? `${l.lastScope === 'aiq' ? 'AIQ · AIR' : 'State · CMR'} ${fmt(l.lastRank)}${[l.lastStream, l.lastCategory].filter(Boolean).map(s => ' · ' + esc(s)).join('')}` : '—';
const waNum = p => p.replace(/\D/g, '');
const contactOf = l => l.phone || l.email || '';
const reachHtml = l => l.phone
  ? `<a class="icon-btn" href="https://wa.me/${waNum(l.phone)}" target="_blank" rel="noopener" aria-label="WhatsApp ${esc(l.name)}" data-stop>${icon.chat}</a>`
  : `<a class="icon-btn" href="mailto:${esc(l.email)}" aria-label="Email ${esc(l.name)}" data-stop>${MAIL_ICON}</a>`;

async function leads() {
  const page = $('#page');
  page.innerHTML = head('Sign-ups', 'Leads', 'Everyone who verified a mobile number or email. Click a row for their shortlist and activity.',
    `<a class="btn btn-line btn-sm" id="lcsv" href="/api/admin/leads?format=csv">${icon.download} Export CSV</a>`) + `
    <div class="mbody">
      <div class="toolbar"><div class="search-wrap">${icon.search}<input class="input" id="lq" type="search" placeholder="Search name, mobile, email or state"></div><span class="count" id="lc"></span></div>
      <div id="lt"><div class="empty"><span class="spinner"></span></div></div>
    </div>`;
  const load = async () => {
    const q = $('#lq').value.trim();
    $('#lcsv').href = '/api/admin/leads?format=csv&q=' + encodeURIComponent(q);
    let r;
    try { r = await call('/api/admin/leads?q=' + encodeURIComponent(q)); } catch (e) { $('#lt').innerHTML = `<div class="alert alert-err">${esc(e.message)}</div>`; return; }
    $('#lc').textContent = `${fmt(r.leads.length)} lead${r.leads.length === 1 ? '' : 's'}`;
    $('#lt').innerHTML = r.leads.length ? `<div class="grid-wrap"><table class="grid">
      <thead><tr><th>Name</th><th>Mobile / email</th><th>State</th><th class="r">CMR</th><th>Signed up</th><th>Last active</th><th class="r">Sign-ins</th><th class="r">Predictions</th><th class="r">Shortlisted</th><th>Last search</th><th></th></tr></thead>
      <tbody>${r.leads.map(l => `<tr class="clickable" data-id="${l.id}">
        <td class="strong">${esc(l.name || '—')}</td><td class="nowrap num">${esc(contactOf(l))}</td>
        <td class="nowrap">${esc(l.state || '—')}</td><td class="n">${fmt(l.cmr)}</td>
        <td class="nowrap">${dateIN(l.createdAt)}</td><td class="nowrap">${ago(l.lastSeenAt)}</td>
        <td class="n">${fmt(l.logins)}</td><td class="n">${fmt(l.predictions)}</td><td class="n">${fmt(l.shortlisted)}</td>
        <td class="nowrap">${lastSearch(l)}</td>
        <td><div class="actions">${reachHtml(l)}</div></td></tr>`).join('')}</tbody>
    </table></div>` : `<div class="panel"><div class="empty"><h3>${q ? 'No matching leads' : 'No sign-ups yet'}</h3><p>${q ? 'Try another name, number or email.' : 'Leads appear here as soon as someone verifies their mobile or email.'}</p></div></div>`;
    $('#lt tbody')?.addEventListener('click', e => {
      if (e.target.closest('[data-stop]')) return;
      const tr = e.target.closest('tr[data-id]');
      if (tr) leadDrawer(+tr.dataset.id, load);
    });
  };
  $('#lq').oninput = debounce(load, 250);
  load();
}
const EV = {
  predict: p => `Ran a prediction — ${p.scope === 'aiq' ? 'AIR' : 'CMR'} ${fmt(p.rank)}${[p.stream, p.category, p.spec, p.college].filter(Boolean).map(s => ' · ' + esc(s)).join('')} <span class="muted">(${fmt(p.results)} seats)</span>`,
  search: p => `Searched cut-offs${p.q ? ` for “${esc(p.q)}”` : ''}${[p.category, p.spec, p.college].filter(Boolean).map(s => ' · ' + esc(s)).join('')}`,
  seat_view: p => `Viewed ${esc(p.spec)} at ${esc(p.college)}${p.category ? ` (${esc(p.category)})` : ''}`,
  shortlist_add: p => `Shortlisted ${esc(p.spec)} at ${esc(p.college)}`,
  export: p => `Exported ${esc(p.mode)} (${fmt(p.rows)} rows)`,
  contact_click: () => 'Clicked “Talk to a counsellor”',
  login: p => p.isNew ? 'Signed up' : 'Signed in',
  signin_open: () => 'Opened sign-in', otp_request: p => `Requested a code by ${p.channel === 'email' ? 'email' : 'SMS'}`,
  profile_update: p => `Updated profile — ${esc(p.state)}${p.cmr ? ' · CMR ' + fmt(p.cmr) : ''}`
};
async function leadDrawer(id, reload) {
  let r;
  try { r = await call('/api/admin/leads/' + id); } catch (e) { return toast(e.message, true); }
  const u = r.user;
  const d = openDrawer(`
    <div class="dr-head" style="padding:22px 24px 18px;border-bottom:1px solid var(--rule)">
      <div class="eyebrow">Lead · joined ${dateIN(u.createdAt)}</div>
      <button class="icon-btn" data-close aria-label="Close" style="position:absolute;right:16px;top:16px">${icon.x}</button>
      <h2 style="margin:10px 0 4px;font:600 24px/1.2 var(--serif)">${esc(u.name || 'No name')}</h2>
      <p class="num" style="margin:0;color:var(--ink-2)">${esc(contactOf(u))}</p>
      <p style="margin:4px 0 0;color:var(--ink-2);font-size:13px">${esc(u.state || 'State not given')}${u.cmr ? ` · NEET-PG CMR <b class="num">${fmt(u.cmr)}</b>` : ''}</p>
      <div style="display:flex;gap:8px;margin-top:14px">
        ${u.phone ? `<a class="btn btn-primary btn-sm" href="https://wa.me/${waNum(u.phone)}" target="_blank" rel="noopener">${icon.chat} WhatsApp</a>
        <a class="btn btn-line btn-sm" href="tel:${esc(u.phone)}">Call</a>`
          : `<a class="btn btn-primary btn-sm" href="mailto:${esc(u.email)}">${MAIL_ICON} Email</a>`}
        <button class="btn btn-danger btn-sm" id="ldel" style="margin-left:auto">${icon.trash} Delete</button>
      </div>
    </div>
    <div style="padding:20px 24px;border-bottom:1px solid var(--rule)">
      <h3 class="eyebrow" style="margin:0 0 12px">Shortlist · ${r.shortlist.length}</h3>
      ${r.shortlist.length ? `<ol style="margin:0;padding-left:20px;font-size:13px;line-height:1.5">${r.shortlist.map(i => `<li style="margin-bottom:8px">
        <b style="font-weight:500">${esc(i.row.speciality || i.row.branch)}</b> — ${esc(i.row.college)}<br>
        <span class="muted">${esc(KLABEL[i.kind])} · ${esc([i.row.stream || i.row.type, i.row.category].join(' · '))} · closing ${fmt(i.row.cmr_close || i.row.close_rank)}</span></li>`).join('')}</ol>`
        : '<p class="muted" style="margin:0;font-size:13px">Nothing shortlisted.</p>'}
    </div>
    <div style="padding:20px 24px">
      <h3 class="eyebrow" style="margin:0 0 6px">Recent activity</h3>
      ${r.activity.length ? `<ul class="tl">${r.activity.map(a => `<li><time>${dateTimeIN(a.ts)}</time><span>${(EV[a.type] || (() => esc(a.type)))(a.props || {})}</span></li>`).join('')}</ul>`
        : '<p class="muted" style="font-size:13px">No activity recorded.</p>'}
    </div>`);
  $('#ldel', d.el).onclick = async () => {
    if (!await confirmDialog('Delete this lead?', `This permanently removes <b>${esc(u.name)}</b>, their shortlist and their sign-in. Activity stays in analytics anonymously.`, { ok: 'Delete lead', danger: true })) return;
    await call('/api/admin/leads/' + id, { method: 'DELETE' });
    d.close(); toast('Lead deleted.'); reload();
  };
}

// =====================================================================
// Datasets
// =====================================================================
async function schema() { return A.schema || (A.schema = await call('/api/admin/schema')); }

async function datasets(arg) {
  if (arg) return rowsPage(+arg);
  const page = $('#page');
  page.innerHTML = head('Cut-off data', 'Datasets', 'Upload a new year or round, correct rows, and choose what the public site shows.',
    `<button class="btn btn-primary btn-sm" id="new">${icon.upload} Upload data</button>`) + `<div class="mbody" id="dl"><div class="empty"><span class="spinner"></span></div></div>`;
  $('#new').onclick = () => uploadWizard();
  let r;
  try { r = await call('/api/admin/datasets'); } catch (e) { $('#dl').innerHTML = `<div class="alert alert-err">${esc(e.message)}</div>`; return; }
  $('#dl').innerHTML = ['state', 'aiq'].map(kind => {
    const list = r.datasets.filter(d => d.kind === kind);
    return `<section class="ds-group"><h2>${KLABEL[kind]} <span>${kind === 'state' ? 'ranked by state CMR' : 'ranked by NEET AIR'} · ${list.filter(d => d.published).length} published</span></h2>
      ${list.length ? `<div class="grid-wrap"><table class="grid">
        <thead><tr><th>Dataset</th><th>State</th><th>Year</th><th>Status</th><th class="r">Seat groups</th><th class="r">Admissions</th><th class="r">Colleges</th><th>Updated</th><th></th></tr></thead>
        <tbody>${list.map(d => `<tr data-id="${d.id}">
          <td class="strong"><a href="#datasets/${d.id}" style="color:inherit">${esc(d.label)}</a>${d.notes ? `<span class="sub">${esc(d.notes)}</span>` : ''}</td>
          <td class="nowrap">${esc(d.state || '—')}</td>
          <td class="nowrap">${d.year}</td>
          <td>${d.published ? '<span class="tag tag-ok">Published</span>' : '<span class="tag">Draft</span>'}</td>
          <td class="n">${fmt(d.rows)}</td><td class="n">${fmt(d.seats)}</td><td class="n">${fmt(d.colleges)}</td>
          <td class="nowrap">${ago(d.updatedAt)}</td>
          <td><div class="actions">
            <button class="btn btn-line btn-sm" data-a="pub">${d.published ? 'Unpublish' : 'Publish'}</button>
            <a class="icon-btn" href="#datasets/${d.id}" aria-label="Browse and edit rows" title="Browse and edit rows">${ROWS_ICON}</a>
            <button class="icon-btn" data-a="replace" aria-label="Replace data" title="Upload replacement data">${icon.upload}</button>
            <a class="icon-btn" href="/api/admin/datasets/${d.id}/export" aria-label="Download CSV" title="Download CSV">${icon.download}</a>
            <button class="icon-btn" data-a="meta" aria-label="Edit details" title="Name, state, year and notes">${icon.edit}</button>
            <button class="icon-btn" data-a="del" aria-label="Delete" title="Delete dataset">${icon.trash}</button>
          </div></td></tr>`).join('')}</tbody></table></div>`
        : `<div class="panel"><div class="empty"><h3>No ${KLABEL[kind]} data</h3><p>Upload a file to add one.</p></div></div>`}
    </section>`;
  }).join('') + `<p class="muted" style="font-size:12.5px;margin-top:20px;max-width:80ch">Each published dataset is shown to candidates who chose
    its state at sign-up, newest year first; when a state has more than one per counselling, they get a dataset picker. Drafts are visible only here.</p>`;

  $('#dl').onclick = async e => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const d = r.datasets.find(x => x.id === +b.closest('tr').dataset.id);
    if (b.dataset.a === 'pub') {
      await call('/api/admin/datasets/' + d.id, { method: 'PATCH', body: { published: !d.published } });
      toast(d.published ? 'Unpublished — hidden from the site.' : 'Published — live on the site.');
      datasets();
    } else if (b.dataset.a === 'del') {
      if (!await confirmDialog('Delete dataset?', `<b>${esc(d.label)}</b> and its ${fmt(d.rows)} rows will be removed permanently. Download a CSV first if you may need it.`, { ok: 'Delete', danger: true })) return;
      await call('/api/admin/datasets/' + d.id, { method: 'DELETE' });
      toast('Dataset deleted.'); datasets();
    } else if (b.dataset.a === 'replace') uploadWizard(d);
    else if (b.dataset.a === 'meta') metaDialog(d);
  };
}

function metaDialog(d) {
  const dlg = openDialog(`
    <div class="dialog-head"><h2>Dataset details</h2><button class="icon-btn" data-close aria-label="Close">${icon.x}</button></div>
    <form id="mf"><div class="dialog-body"><div class="form-grid">
      <label class="field span2"><span class="label">Name shown on the site</span><input class="input" name="label" value="${esc(d.label)}" required maxlength="120"></label>
      <label class="field"><span class="label">State <span class="hint">who sees it</span></span>${stateSelect('name="state" required', d.state)}</label>
      <label class="field"><span class="label">Counselling year</span><input class="input" name="year" type="number" value="${d.year}" min="2000" max="2100" required></label>
      <label class="field span2"><span class="label">Internal notes</span><textarea class="textarea" name="notes" maxlength="1000">${esc(d.notes)}</textarea></label>
    </div></div>
    <div class="dialog-foot"><button type="button" class="btn btn-line" data-close>Cancel</button><button class="btn btn-primary">Save</button></div></form>`);
  $('#mf', dlg.el).onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    try { await call('/api/admin/datasets/' + d.id, { method: 'PATCH', body: { label: f.label.value, state: f.state.value, year: f.year.value, notes: f.notes.value } }); dlg.close(); toast('Saved.'); datasets(); }
    catch (err) { toast(err.message, true); }
  };
}

// ---- file parsing ------------------------------------------------------
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.slice(0, text.indexOf('\n') >>> 0 || 1000);
  const delim = [',', ';', '\t'].map(c => [c, first.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
async function readTable(file) {
  if (/\.(xlsx|xls|ods)$/i.test(file.name)) {
    const XLSX = await import(SHEETJS);
    const wb = XLSX.read(await file.arrayBuffer());
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
  }
  return parseCsv(await file.text());
}

// ---- upload wizard (new dataset, or replace an existing one) -------------
async function uploadWizard(existing) {
  const sc = await schema();
  const st = { kind: existing?.kind || 'state', format: 'columns', table: null, file: '', mode: 'replace', state: A.lastState || '' };
  const dlg = openDialog(`
    <div class="dialog-head"><h2>${existing ? 'Replace data' : 'Upload data'}</h2><button class="icon-btn" data-close aria-label="Close">${icon.x}</button></div>
    <div id="wz"></div>`, { wide: true });
  const wz = $('#wz', dlg.el);

  function step1(err) {
    const cols = sc[st.kind][st.format === 'allotment' ? 'allotment' : 'columns'];
    wz.innerHTML = `<div class="dialog-body">
      ${existing ? `<p style="margin:0 0 18px;color:var(--ink-2)">Updating <b>${esc(existing.label)}</b> (${fmt(existing.rows)} rows).</p>` : `
      <div class="field"><span class="label">Counselling</span>
        <div class="seg" role="group">${['state', 'aiq'].map(k => `<button type="button" data-k="${k}" aria-pressed="${st.kind === k}">${KLABEL[k]}</button>`).join('')}</div></div>`}
      <div class="field"><span class="label">File layout</span>
        <div class="seg" role="group">
          <button type="button" data-fm="columns" aria-pressed="${st.format === 'columns'}">Cut-off summary</button>
          <button type="button" data-fm="allotment" aria-pressed="${st.format === 'allotment'}">Allotment list</button>
        </div>
        <p class="muted" style="font-size:12.5px;margin:8px 0 0;line-height:1.55">${st.format === 'allotment'
          ? 'One row per admitted candidate, straight from the allotment result. We group them into seats and compute opening/closing ranks for you.'
          : 'One row per college × speciality × category, with opening and closing ranks already worked out.'}</p></div>
      ${existing ? `<div class="field"><span class="label">What to do with existing rows</span>
        <div class="seg" role="group"><button type="button" data-md="replace" aria-pressed="${st.mode === 'replace'}">Replace all rows</button>
          <button type="button" data-md="append" aria-pressed="${st.mode === 'append'}">Add to existing rows</button></div></div>` : ''}
      <div class="field"><span class="label">File <span class="hint">CSV or Excel · first row must be headers</span></span>
        <label class="drop" id="drop"><input type="file" accept=".csv,.txt,.xlsx,.xls,.ods" id="file">
          <b>${st.file ? esc(st.file) : 'Choose a file or drop it here'}</b>
          <span>${st.table ? `${fmt(st.table.length - 1)} data rows read` : 'Excel sheets are read from the first tab'}</span></label></div>
      <p class="muted" style="font-size:12.5px;line-height:1.6;margin:12px 0 0">Expected columns: ${cols.map(c => `<code style="font:400 12px var(--mono)">${c.name}</code>${c.optional ? ' <span class="muted">(optional)</span>' : ''}`).join(', ')}.
        Common header spellings are recognised automatically. <a href="/api/admin/template?kind=${st.kind}&format=${st.format}">Download a template</a>.</p>
      ${err ? `<div class="alert alert-err" style="margin-top:14px">${esc(err)}</div>` : ''}
    </div>
    <div class="dialog-foot"><button class="btn btn-line" data-close>Cancel</button><button class="btn btn-primary" id="chk" ${st.table ? '' : 'disabled'}>Check file ${icon.arrowR}</button></div>`;

    $$('[data-k]', wz).forEach(b => b.onclick = () => { st.kind = b.dataset.k; step1(); });
    $$('[data-fm]', wz).forEach(b => b.onclick = () => { st.format = b.dataset.fm; step1(); });
    $$('[data-md]', wz).forEach(b => b.onclick = () => { st.mode = b.dataset.md; step1(); });
    const take = async file => {
      if (!file) return;
      try { st.table = await readTable(file); st.file = file.name; step1(); }
      catch (e) { st.table = null; step1('Could not read that file: ' + e.message); }
    };
    $('#file', wz).onchange = e => take(e.target.files[0]);
    const drop = $('#drop', wz);
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); take(e.dataTransfer.files[0]); };
    $('#chk', wz).onclick = check;
  }

  const defaultLabel = year => {
    const where = st.state || 'State';
    return `${st.kind === 'state' ? `${where} state counselling` : `All India Quota — ${where} colleges`} ${year}`;
  };

  async function check() {
    $('#chk', wz).innerHTML = '<span class="spinner"></span> Checking';
    let rep;
    try { rep = await call('/api/admin/datasets/preview', { method: 'POST', body: { kind: st.kind, format: st.format, table: st.table } }); }
    catch (e) { return step1(e.message); }
    if (rep.missing.length) return step1(`The file is missing required columns: ${rep.missing.join(', ')}. Check the header row, or switch the file layout.`);
    const cols = sc[st.kind].columns;
    const yearGuess = (st.file.match(/20\d\d/) || [new Date().getFullYear()])[0];
    wz.innerHTML = `<div class="dialog-body">
      <dl class="report">
        <div><dt>Rows in file</dt><dd>${fmt(rep.input)}</dd></div>
        <div><dt>${st.format === 'allotment' ? 'Seat groups' : 'Valid rows'}</dt><dd>${fmt(rep.rows)}</dd></div>
        <div><dt>Admissions</dt><dd>${fmt(rep.seats)}</dd></div>
        <div><dt>Colleges</dt><dd>${fmt(rep.colleges)}</dd></div>
      </dl>
      ${rep.errors.length ? `<div class="alert alert-warn" style="margin-bottom:10px"><b>${rep.input - (rep.accepted ?? rep.rows)} row(s) will be skipped.</b> First problems:</div>
        <ol class="errlist">${rep.errors.map(e => `<li>Line ${e.line}: ${esc(e.message)}</li>`).join('')}</ol>` : `<div class="alert alert-info" style="margin-bottom:16px">Every row passed validation.</div>`}
      <div class="grid-wrap preview"><table class="grid"><thead><tr>${cols.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
        <tbody>${rep.sample.map(r => `<tr>${cols.map(c => `<td class="${c.type === 'int' ? 'n' : 'nowrap'}">${c.type === 'int' ? fmt(r[c.name]) : esc(r[c.name])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <p class="muted" style="font-size:12px;margin:8px 0 0">First ${rep.sample.length} of ${fmt(rep.rows)} rows as they will be stored.</p>
      ${existing ? '' : `<div class="form-grid" style="margin-top:20px">
        <label class="field"><span class="label">State <span class="hint">candidates who chose it see this data</span></span>${stateSelect('id="dst"', st.state)}</label>
        <label class="field"><span class="label">Name shown on the site</span><input class="input" id="lbl" maxlength="120" value="${esc(defaultLabel(yearGuess))}"></label>
        <label class="field"><span class="label">Counselling year</span><input class="input" id="yr" type="number" min="2000" max="2100" value="${yearGuess}"></label>
        <label class="field span2"><span class="label">Internal notes <span class="hint">optional — e.g. source, round</span></span><input class="input" id="nt" maxlength="1000" value="${esc('Uploaded from ' + st.file)}"></label>
      </div>`}
    </div>
    <div class="dialog-foot"><button class="btn btn-line" id="back">Back</button>
      ${existing ? `<button class="btn btn-primary" id="save" ${rep.rows ? '' : 'disabled'}>${st.mode === 'append' ? 'Add' : 'Replace with'} ${fmt(rep.rows)} rows</button>`
        : `<button class="btn btn-line" id="draft" ${rep.rows ? '' : 'disabled'}>Save as draft</button><button class="btn btn-primary" id="pub" ${rep.rows ? '' : 'disabled'}>Save and publish</button>`}
    </div>`;
    $('#back', wz).onclick = () => step1();
    // Keep the suggested name in step with the state until the admin edits it.
    $('#dst', wz)?.addEventListener('change', e => {
      const lbl = $('#lbl', wz), was = defaultLabel(yearGuess);
      st.state = e.target.value;
      if (lbl.value === was) lbl.value = defaultLabel(yearGuess);
    });
    const save = async publish => {
      try {
        if (existing) {
          await call(`/api/admin/datasets/${existing.id}/replace`, { method: 'POST', body: { format: st.format, table: st.table, mode: st.mode } });
          toast('Data updated.');
        } else {
          if (!st.state) return toast('Choose the state this data is for.', true);
          await call('/api/admin/datasets', { method: 'POST', body: { kind: st.kind, state: st.state, format: st.format, table: st.table, label: $('#lbl', wz).value, year: $('#yr', wz).value, notes: $('#nt', wz).value, publish } });
          A.lastState = st.state;
          toast(publish ? 'Dataset published.' : 'Saved as draft.');
        }
        dlg.close();
        location.hash === '#datasets' ? datasets() : (location.hash = '#datasets');
      } catch (e) { toast(e.message, true); }
    };
    $('#save', wz)?.addEventListener('click', () => save(false));
    $('#draft', wz)?.addEventListener('click', () => save(false));
    $('#pub', wz)?.addEventListener('click', () => save(true));
  }
  step1();
}

// ---- row browser + editor ----------------------------------------------
async function rowsPage(id) {
  const page = $('#page');
  page.innerHTML = `<div class="mbody"><div class="empty"><span class="spinner"></span></div></div>`;
  let r;
  try { r = await call(`/api/admin/datasets/${id}/rows`); } catch (e) { page.innerHTML = `<div class="mbody"><div class="alert alert-err">${esc(e.message)}</div></div>`; return; }
  const d = r.dataset, cols = r.columns;
  let shown = 200;
  page.innerHTML = head(`<a href="#datasets">Datasets</a> / ${KLABEL[d.kind]}`, esc(d.label),
    `${fmt(d.rows)} rows · ${fmt(d.seats)} admissions · ${d.published ? 'published' : 'draft'} · updated ${ago(d.updatedAt)}`,
    `<a class="btn btn-line btn-sm" href="/api/admin/datasets/${d.id}/export">${icon.download} CSV</a>
     <button class="btn btn-line btn-sm" id="rep">${icon.upload} Replace data</button>
     <button class="btn btn-primary btn-sm" id="add">${icon.plus} Add row</button>`) + `
    <div class="mbody">
      <div class="toolbar"><div class="search-wrap">${icon.search}<input class="input" id="rq" type="search" placeholder="Filter rows — college, speciality, category"></div><span class="count" id="rc"></span></div>
      <div class="grid-wrap" style="max-height:calc(100vh - 260px)"><table class="grid">
        <thead><tr>${cols.map(c => `<th class="${c.type === 'int' ? 'r' : ''}">${esc(c.label)}</th>`).join('')}<th></th></tr></thead><tbody id="rb"></tbody></table></div>
      <div class="more" id="rmore" hidden style="border:1px solid var(--rule);border-top:0;background:var(--surface);display:flex;justify-content:center;padding:14px"></div>
    </div>`;
  const draw = () => {
    const terms = $('#rq').value.toLowerCase().split(/\s+/).filter(Boolean);
    const list = r.rows.filter(row => !terms.length || terms.every(t => cols.some(c => String(row[c.name]).toLowerCase().includes(t))));
    $('#rc').textContent = `${fmt(list.length)} of ${fmt(r.rows.length)} rows`;
    $('#rb').innerHTML = list.slice(0, shown).map(row => `<tr class="clickable" data-id="${row.id}">${cols.map(c =>
      `<td class="${c.type === 'int' ? 'n' : c.name === 'college' || c.name === 'speciality' || c.name === 'branch' ? '' : 'nowrap'}">${c.type === 'int' ? fmt(row[c.name]) : esc(row[c.name])}</td>`).join('')}
      <td><button class="icon-btn" aria-label="Edit row">${icon.edit}</button></td></tr>`).join('');
    const m = $('#rmore');
    m.hidden = list.length <= shown;
    m.innerHTML = `<button class="btn btn-line btn-sm">Show more (${fmt(list.length - shown)} hidden)</button>`;
    m.firstChild.onclick = () => { shown += 200; draw(); };
  };
  $('#rq').oninput = debounce(() => { shown = 200; draw(); }, 150);
  $('#rb').onclick = e => { const tr = e.target.closest('tr[data-id]'); if (tr) rowEditor(d, cols, r.rows.find(x => x.id === +tr.dataset.id), () => rowsPage(id), r.rows); };
  $('#add').onclick = () => rowEditor(d, cols, null, () => rowsPage(id), r.rows);
  $('#rep').onclick = () => uploadWizard(d);
  draw();
}

function rowEditor(d, cols, row, done, all = []) {
  // existing values as suggestions, so new rows reuse the exact spellings
  const lists = cols.filter(c => c.type === 'text' && c.name !== 'rounds').map(c =>
    `<datalist id="dl-${c.name}">${[...new Set(all.map(x => x[c.name]))].sort().map(v => `<option value="${esc(v)}">`).join('')}</datalist>`).join('');
  const input = c => {
    const v = row ? row[c.name] : '';
    if (c.type === 'stream') return `<select class="select" name="${c.name}">${['Direct', 'In-service'].map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
    if (c.type === 'ctype') return `<select class="select" name="${c.name}">${['Government', 'Private'].map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
    if (c.type === 'int') return `<input class="input num" name="${c.name}" type="number" min="0" step="1" value="${v ?? ''}" ${c.optional ? '' : 'required'}>`;
    return `<input class="input" name="${c.name}" value="${esc(v)}" ${c.optional ? '' : 'required'} list="dl-${c.name}">`;
  };
  const dlg = openDialog(`
    <div class="dialog-head"><h2>${row ? 'Edit row' : 'Add row'}</h2><button class="icon-btn" data-close aria-label="Close">${icon.x}</button></div>
    <form id="rf"><div class="dialog-body"><div class="form-grid">
      ${cols.map(c => `<label class="field ${['college', 'speciality', 'branch'].includes(c.name) ? 'span2' : ''}"><span class="label">${esc(c.label)}${c.optional ? '<span class="hint">optional</span>' : ''}</span>${input(c)}</label>`).join('')}
    </div><div id="rerr"></div>${lists}</div>
    <div class="dialog-foot">${row ? `<button type="button" class="btn btn-danger" id="rdel" style="margin-right:auto">${icon.trash} Delete row</button>` : ''}
      <button type="button" class="btn btn-line" data-close>Cancel</button><button class="btn btn-primary">${row ? 'Save changes' : 'Add row'}</button></div></form>`, { wide: true });
  $('#rf', dlg.el).onsubmit = async e => {
    e.preventDefault();
    const body = Object.fromEntries(cols.map(c => [c.name, e.target[c.name].value]));
    try {
      await call(`/api/admin/datasets/${d.id}/rows${row ? '/' + row.id : ''}`, { method: row ? 'PATCH' : 'POST', body });
      dlg.close(); toast(row ? 'Row saved.' : 'Row added.'); done();
    } catch (err) { $('#rerr', dlg.el).innerHTML = `<div class="alert alert-err" style="margin-top:16px">${esc(err.message)}</div>`; }
  };
  $('#rdel', dlg.el)?.addEventListener('click', async () => {
    if (!await confirmDialog('Delete this row?', 'It disappears from the public site immediately if this dataset is published.', { ok: 'Delete row', danger: true })) return;
    await call(`/api/admin/datasets/${d.id}/rows/${row.id}`, { method: 'DELETE' });
    dlg.close(); toast('Row deleted.'); done();
  });
}

// =====================================================================
// Settings
// =====================================================================
async function settings() {
  const page = $('#page');
  let r;
  try { r = await call('/api/admin/settings'); } catch (e) { page.innerHTML = `<div class="mbody"><div class="alert alert-err">${esc(e.message)}</div></div>`; return; }
  const s = r.settings;
  page.innerHTML = head('Configuration', 'Settings', 'Site text and contact details. Changes go live immediately.') + `
    <div class="mbody"><div class="row r2" style="margin-top:0;align-items:start">
      <form class="panel" id="sf"><div class="panel-head"><h2>Site</h2></div><div class="panel-body">
        <label class="field"><span class="label">Brand name</span><input class="input" name="brand" value="${esc(s.brand)}" maxlength="60"></label>
        <label class="field"><span class="label">Announcement bar <span class="hint">shown on every page · leave blank to hide</span></span>
          <textarea class="textarea" name="announcement" maxlength="500" placeholder="e.g. Round 2 choice filling closes 14 Oct, 5 pm.">${esc(s.announcement)}</textarea></label>
        <label class="field"><span class="label">Counsellor WhatsApp <span class="hint">with country code · adds “Talk to a counsellor”</span></span>
          <input class="input num" name="whatsapp" value="${esc(s.whatsapp)}" placeholder="+91 98765 43210"></label>
        <label class="field"><span class="label">Contact email</span><input class="input" name="contact_email" type="email" value="${esc(s.contact_email)}"></label>
        <button class="btn btn-primary" style="margin-top:20px">Save settings</button>
      </div></form>
      <div class="panel"><div class="panel-head"><h2>Mobile sign-in (OTP)</h2></div><div class="panel-body prose-sm">
        <dl class="provider"><dt>Provider</dt><dd>${r.provider === 'firebase' ? '<span class="tag tag-ok">Firebase phone auth</span>' : '<span class="tag tag-warn">Test mode — code 1234</span>'}</dd></dl>
        ${r.provider === 'firebase' ? `<p>Real SMS codes are sent by Google Firebase. Usage and SMS charges are visible in the Firebase console under Authentication → Usage.</p>` : `
        <p>No SMS is sent; any number signs in with <code>1234</code>. To switch on real SMS with Google Firebase:</p>
        <ol>
          <li>Create a project at <code>console.firebase.google.com</code> and upgrade it to the <b>Blaze</b> (pay-as-you-go) plan — phone sign-in requires it.</li>
          <li>Authentication → Sign-in method → enable <b>Phone</b>. Under Settings → SMS region policy, allow India.</li>
          <li>Authentication → Settings → Authorized domains: add your site's domain.</li>
          <li>Project settings → Your apps → add a <b>Web app</b> and copy its config.</li>
          <li>On the server set <code>AUTH_PROVIDER=firebase</code> plus <code>FIREBASE_API_KEY</code>, <code>FIREBASE_AUTH_DOMAIN</code>, <code>FIREBASE_PROJECT_ID</code> and <code>FIREBASE_APP_ID</code>, then restart.</li>
        </ol>
        <p>The developer can do steps 4–5 in a few minutes once the project exists.</p>`}
      </div></div>
    </div></div>`;
  $('#sf').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    try {
      await call('/api/admin/settings', { method: 'PUT', body: { brand: f.brand.value, announcement: f.announcement.value, whatsapp: f.whatsapp.value, contact_email: f.contact_email.value } });
      toast('Settings saved.');
    } catch (err) { toast(err.message, true); }
  };
}

boot();
