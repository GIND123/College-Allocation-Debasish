import {
  esc, fmt, debounce, $, $$, uniq, store, api, track, toast, openDialog, openDrawer, downloadCsv, icon, toggleTheme
} from './lib.js';

const STEP = 150;
const FIREBASE_SDK = '12.19.0';
const BAND = { 4: 'Very high', 3: 'High', 2: 'Moderate', 1: 'Low' };
const KIND = {
  state: {
    label: 'State counselling', rank: 'CMR', spec: 'speciality', specLabel: 'Speciality',
    open: 'cmr_open', close: 'cmr_close', openCat: 'UR', filters: ['stream', 'prog', 'category', 'quota', 'type', 'speciality', 'college'],
    get rankLong() { return `${myState()} CMR`; },
    get note() {
      return S.data?.closingOnly
        ? `Ranked by the ${myState()} state merit number (your CMR). Only the last rank admitted to each seat is published.`
        : `Ranked by the ${myState()} combined merit rank (CMR). Direct and in-service candidates are on separate merit lists.`;
    }
  },
  aiq: {
    label: 'All India Quota', rank: 'AIR', rankLong: 'NEET All India Rank', spec: 'branch', specLabel: 'Branch',
    open: 'open_rank', close: 'close_rank', openCat: 'GENERAL', filters: ['prog', 'category', 'quota', 'type', 'state', 'branch', 'college'],
    get note() {
      const where = S.data?.rows?.some(r => r.state) ? 'across India' : `in ${S.data?.dataset?.label.replace(/^.*— | colleges.*$/g, '') || myState()} colleges`;
      return S.data?.rows?.some(r => r.quota)
        ? `Seats ${where} filled by the MCC on NEET All India Rank: the All India Quota, deemed universities, DNB and more. ${/Round 1/.test(S.data.dataset?.label || '') ? 'Ranks are Round 1 allotments; later rounds usually go further. ' : ''}Narrow by college state, quota or Govt / private under More filters.`
        : `Seats ${where} filled by the MCC on NEET All India Rank — a national pool, separate from state counselling.`;
    }
  }
};
const myState = () => S.user?.state || 'State';
const profileComplete = () => !!(S.user?.name && S.user?.air && S.user?.state);
const FILTER_LABEL = { quota: 'Quota', stream: 'Stream', category: 'Category', programme: 'Programme', speciality: 'Speciality', branch: 'Branch', college: 'College', type: 'College type', state: 'College state' };
const ALL_LABEL = { quota: 'All quotas', category: 'All categories', programme: 'All programmes', speciality: 'All specialities', branch: 'All branches', college: 'All colleges', type: 'Government & private', state: 'All states' };
// The three programmes, from a seat's programme (state data) or course name (All India: "DNB Diploma …", "DNB …", "MD …").
const PROGS = ['MD/MS', 'DNB', 'Diploma'];
const progOf = v => /diploma/i.test(v) ? 'Diploma' : /^(DNB|NBEMS)\b|\bDNB\b/i.test(v) ? 'DNB' : 'MD/MS';
// State counselling lists don't say who runs a college. These are the private (and public-private) ones in the
// built-in data; everything else there is a government, government-society (GMERS) or municipal college.
const PRIVATE_COLLEGE = /Hi-Tech|DRIEMS|\(Management\)|M\. K\. Shah|GCS Medical|N\. D\. Desai|Parul|C\.U\. Shah|Pramukh Swami|Adani|Zydus|Kiran Medical|Nootan|Swaminarayan|Shantabaa|Ananya/i;
// Filters that only some datasets carry: shown when the data has values for them.
const OPTIONAL_FILTERS = ['quota', 'state'];

/**
 * Same thresholds as the original tool: lower rank is better. Where only the last admitted
 * rank is published (closingOnly: Gujarat), there is no range to place the rank in, so the
 * grade is how far inside that closing rank it is: 20%+ inside, 10-20%, within 10%, up to 15% past.
 */
function band(rank, open, close, closingOnly = false) {
  if (closingOnly) {
    if (rank <= close * 0.8) return 4;
    if (rank <= close * 0.9) return 3;
    if (rank <= close) return 2;
    return rank <= close * 1.15 ? 1 : 0;
  }
  if (rank <= open) return 4;
  if (rank <= open + (close - open) * 0.5) return 3;
  if (rank <= close) return 2;
  if (rank <= close * 1.15) return 1;
  return 0;
}
// A seat whose source publishes no seat count carries only its closing rank.
const closingOnly = r => r.seats === 0;
const grade = (rank, r, K) => band(rank, r[K.open], r[K.close], closingOnly(r));
// Quota where the state publishes one (Gujarat), otherwise the stream (Odisha).
const seatPool = r => r.quota || r.stream || '';
// An All India seat: college type, and MCC's quota where known.
const poolOf = (kind, r) => kind === 'state' ? seatPool(r) : [r.type, r.quota, r.state].filter(Boolean).join(' · ');
// Must match rowKey() in server/index.js — it identifies a shortlisted seat.
const rowKey = (kind, r) => kind === 'state'
  ? [r.college, r.speciality, r.programme, r.stream, r.category].join(' | ') + (r.quota ? ' | ' + r.quota : '')
  : [r.college, r.branch, r.category].join(' | ') + ' | ' + r.type + (r.quota ? ' | ' + r.quota : '') + (r.state ? ' | ' + r.state : '');
// Display names for the long official titles in the national AIQ list, matched
// to the names the state list uses. Anything not listed shows in full.
const SHORT = {
  'acharya harihar regional cancer centre, cuttack': 'AHPGIC Cuttack',
  'institute of medical sciences & sum hospital, bhubaneswar': 'IMS & SUM Hospital Bhubaneswar',
  'kalinga institute of medical sciences, bhubaneswar': 'KIMS Bhubaneswar',
  'mkcg medical college, berhampur': 'MKCG MCH Berhampur',
  'post graduate institute of medical education and research & capital hospital, bhubaneswar': 'PGIMER Bhubaneswar',
  'pt. raghunath murmu medical college and hospital, baripada, odisha': 'PRM MCH Baripada',
  'scb medical college, cuttack': 'SCB MCH Cuttack',
  'veer surendra sai institute of medical sciences and research, burla': 'VIMSAR Burla'
};
const shortCollege = n => {
  if (SHORT[n.toLowerCase()]) return SHORT[n.toLowerCase()];
  const m = /\(Renamed as (.+?)\),\s*(.+)$/i.exec(n);
  if (!m) return n;
  return m[1].replace(/Medical College (&|and) Hospital/i, 'MCH').replace(/\b([A-Z])\w+ ([A-Z])\w+ MCH/, '$1$2 MCH') + ' ' + m[2];
};
const mobile = matchMedia('(max-width:720px)');
// A candidate is on exactly one merit list: direct or in-service (never both).
const STREAMS = [['Direct', 'Direct'], ['In-service', 'In-service']];
const freshFilters = () => ({
  state: { rank: '', stream: 'Direct', prog: '', category: '', withOpen: true, quota: '', type: '', speciality: '', college: '', q: '' },
  aiq: { rank: '', prog: '', category: '', withOpen: true, quota: '', type: '', state: '', branch: '', college: '', q: '' }
});

const S = {
  cfg: null, user: null,
  scope: store.get('rr-scope', 'state') === 'aiq' ? 'aiq' : 'state',
  dsId: { state: null, aiq: null },
  cache: new Map(),
  shortlist: [],
  f: Object.assign(freshFilters(), store.get('rr-filters', {})),
  sort: {},
  data: null, mode: null, list: [], shown: STEP,
  path: null, intended: null
};
// Saved filters from older versions may hold '' (the removed "Both" option).
if (!STREAMS.some(([v]) => v === S.f.state.stream)) S.f.state.stream = 'Direct';
const view = $('#view');
const saveFilters = debounce(() => store.set('rr-filters', S.f), 400);

// =====================================================================
// Boot + routing
// =====================================================================
async function boot() {
  try { S.cfg = await api('/api/config'); }
  catch (e) { view.innerHTML = `<div class="gate"><h1>We couldn't reach the server</h1><p>${esc(e.message)}</p></div>`; return; }
  S.user = S.cfg.user;
  if (S.user) { applyProfile(); loadShortlist(); }
  const s = S.cfg.settings;
  if (s.brand) $('#footbrand').textContent = s.brand;
  if (s.announcement) {
    const a = $('#announce');
    a.innerHTML = `<div><b>Notice</b><span>${esc(s.announcement)}</span></div>`;
    a.hidden = false;
  }
  renderTop();
  route();
}

const ROUTES = {
  '/': viewHome, '/predict': () => viewWork('predict'), '/cutoffs': () => viewWork('cutoffs'), '/shortlist': viewShortlist,
  '/method': viewMethod, '/counselling': viewGuides, '/roadmap': viewRoadmap, '/seats': viewSeats
};
const GATED = new Set(['/predict', '/cutoffs', '/shortlist']);

function go(path) { history.pushState({}, '', path); route(); }
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.origin !== location.origin) return;
  e.preventDefault();
  go(a.pathname);
});
addEventListener('popstate', () => { if (location.pathname !== S.path) route(); });
addEventListener('hashchange', () => { if (S.path === '/counselling') viewGuides(); }); // old /counselling#state links

async function route() {
  const path = location.pathname.replace(/(.)\/+$/, '$1');
  let p = path.startsWith('/roadmap') ? '/roadmap' : ROUTES[path] ? path : '/'; // /roadmap/<region>/<stage>/… is one view
  if (p === '/' && S.user) { history.replaceState({}, '', '/predict'); p = '/predict'; }
  const changed = p !== S.path;
  S.path = p;
  const tab = GATED.has(p) ? '/predict' : p === '/roadmap' ? '/counselling' : p; // cut-offs and shortlist live under "Intelligent prediction"
  $$('#nav a').forEach(a => a.pathname === tab ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  if ((GATED.has(p) || p === '/seats') && !S.user) viewGate(p);
  else if (GATED.has(p) && !profileComplete()) viewProfile();
  else await ROUTES[p]();
  if (changed) { scrollTo(0, 0); track('pageview'); }
}

// =====================================================================
// Top bar
// =====================================================================
const initials = n => (n || '').split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '·';
const prettyPhone = p => p ? p.replace(/^\+91(\d{5})(\d{5})$/, '+91 $1 $2') : '';
function waLink(text) {
  const n = (S.cfg.settings.whatsapp || '').replace(/\D/g, '');
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : '';
}

function renderTop() {
  const el = $('#topright');
  const wa = waLink('Hi, I would like help with PG counselling choices.');
  el.innerHTML = `
    <button class="icon-btn" id="theme" aria-label="Switch light / dark">${icon.moon}</button>
    ${wa ? `<a class="btn btn-line btn-sm" href="${esc(wa)}" target="_blank" rel="noopener" id="counsel">${icon.chat}<span class="counsel-label">Talk to a counsellor</span></a>` : ''}
    ${S.user ? `
      <div class="acct">
        <button class="acct-btn" id="acct" aria-haspopup="menu" aria-expanded="false">
          <span class="avatar">${esc(initials(S.user.name))}</span><span class="acct-name">${esc(S.user.name.split(' ')[0])}</span>
        </button>
      </div>` : `<button class="btn btn-primary btn-sm" id="signin">Sign in</button>`}`;
  $('#theme').onclick = toggleTheme;
  $('#counsel')?.addEventListener('click', () => track('contact_click', { from: 'topbar' }));
  $('#signin')?.addEventListener('click', () => openSignIn());
  $('#acct')?.addEventListener('click', e => { e.stopPropagation(); toggleMenu(); });
  updateCount();
}
function toggleMenu() {
  const host = $('.acct');
  const open = host.querySelector('.menu');
  if (open) { open.remove(); $('#acct').setAttribute('aria-expanded', 'false'); return; }
  const m = document.createElement('div');
  m.className = 'menu';
  m.setAttribute('role', 'menu');
  m.innerHTML = `
    <div class="menu-head"><b>${esc(S.user.name)}</b><span>${esc(prettyPhone(S.user.phone) || S.user.email || '')}</span>
      ${S.user.state ? `<span>${esc(S.user.state)}${S.user.air ? ` · AIR ${fmt(S.user.air)}` : ''}${S.user.cmr ? ` · CMR ${fmt(S.user.cmr)}` : ''}</span>` : ''}</div>
    <a href="/shortlist" data-link role="menuitem">${icon.star} My shortlist</a>
    <button role="menuitem" id="m-name">${icon.user} Edit profile</button>
    <button role="menuitem" id="m-out">${icon.logout} Sign out</button>`;
  host.append(m);
  $('#acct').setAttribute('aria-expanded', 'true');
  const close = e => { if (!m.contains(e.target)) { m.remove(); $('#acct')?.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close));
  m.addEventListener('click', e => { if (e.target.closest('a')) { m.remove(); document.removeEventListener('click', close); } });
  $('#m-out').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    S.user = null; S.shortlist = []; S.cache.clear(); S.rpInfo = S.rpData = S.lastYear = null;
    renderTop(); go('/');
    toast('Signed out.');
  };
  $('#m-name').onclick = () => { m.remove(); editProfile(); };
}
function editProfile() {
  const d = openDialog(`
    <div class="dialog-head"><h2>Your profile</h2><button class="icon-btn" data-close aria-label="Close">${icon.x}</button></div>
    <div class="dialog-body" id="pf"></div>`);
  profileForm(d.el.querySelector('#pf'), { onCancel: () => d.close(), onSaved: () => { d.close(); toast('Profile saved.'); route(); } });
}

// =====================================================================
// Profile: name, NEET-PG rank (All India Rank), state, and the state CMR once known (the state decides which data shows)
// =====================================================================
function stateOptions(sel) {
  const have = S.cfg.stateData || [];
  const opt = s => `<option ${s === sel ? 'selected' : ''}>${esc(s)}</option>`;
  const rest = S.cfg.states.filter(s => !have.includes(s));
  return `<option value="">Choose your state</option>` + (have.length
    ? `<optgroup label="State counselling cut-offs available">${have.map(opt).join('')}</optgroup><optgroup label="All states and UTs">${rest.map(opt).join('')}</optgroup>`
    : rest.map(opt).join(''));
}
const airField = v => `<label class="field"><span class="label">NEET-PG rank <span class="hint">All India Rank</span></span>
  <input class="input num" name="air" inputmode="numeric" autocomplete="off" placeholder="e.g. 24500" value="${esc(v ?? '')}" maxlength="7" required></label>`;
// The state CMR is the rank on the state merit list, a different number from the NEET-PG rank.
const cmrField = v => `<label class="field"><span class="label">State CMR <span class="hint">optional · your rank on the state merit list</span></span>
  <input class="input num" name="cmr" inputmode="numeric" autocomplete="off" placeholder="Leave empty if not out yet" value="${esc(v ?? '')}" maxlength="7"></label>`;
const stateField = v => `<label class="field"><span class="label">State</span><select class="select" name="state" required>${stateOptions(v)}</select></label>`;

/** The state CMR (once known) starts state counselling; the NEET-PG rank starts the All India Quota. */
function applyProfile(force = false) {
  const set = (kind, v) => { if (force || !S.f[kind].rank) S.f[kind].rank = v ? String(v) : ''; };
  set('state', S.user?.cmr); set('aiq', S.user?.air);
  saveFilters();
}

function profileForm(host, { onSaved, onCancel }) {
  const u = S.user;
  const draw = err => {
    host.innerHTML = `<form class="auth" novalidate>
      <label class="field"><span class="label">Full name</span><input class="input" name="name" autocomplete="name" value="${esc(u.name)}" maxlength="80" required></label>
      <div class="auth-pair">${airField(u.air)}${stateField(u.state)}</div>
      ${cmrField(u.cmr)}
      ${err ? `<div class="alert alert-err form-err" role="alert">${esc(err)}</div>` : ''}
      <div class="auth-actions">${onCancel ? '<button type="button" class="btn btn-line" data-cancel>Cancel</button>' : ''}
        <button class="btn btn-primary">Save and continue</button></div>
    </form>`;
    const f = host.querySelector('form'), el = n => f.elements.namedItem(n);
    if (onCancel) f.querySelector('[data-cancel]').onclick = onCancel;
    f.onsubmit = async e => {
      e.preventDefault();
      const body = { name: el('name').value.trim(), air: el('air').value.replace(/\D/g, ''), cmr: el('cmr').value.replace(/\D/g, '') || null, state: el('state').value };
      if (body.name.length < 2) return draw('Enter your full name.');
      if (!body.air) return draw('Enter your NEET-PG rank (All India Rank).');
      if (!body.state) return draw('Choose your state.');
      if (body.state !== S.user.state && body.cmr === String(S.user.cmr)) body.cmr = null; // another state: another merit list
      try {
        const prev = S.user;
        S.user = (await api('/api/me', { method: 'PATCH', body })).user;
        if (prev.state !== S.user.state) {
          // Another state's data: start from clean filters and its datasets.
          S.f = freshFilters(); S.dsId = { state: null, aiq: null };
          S.cfg = await api('/api/config').catch(() => S.cfg);
        }
        S.rpInfo = S.rpData = S.lastYear = null;
        applyProfile(prev.cmr !== S.user.cmr || prev.air !== S.user.air || prev.state !== S.user.state);
        renderTop();
        onSaved();
      } catch (err) { draw(err.message); }
    };
  };
  draw();
}

function viewProfile() {
  view.innerHTML = `<div class="gate">
    <div class="eyebrow">One more step</div>
    <h1>Complete your profile</h1>
    <p>We show cut-offs for the state you choose. Add your NEET-PG rank and state to continue.</p>
    <div class="auth-card" id="pf"></div>
  </div>`;
  profileForm($('#pf'), { onSaved: () => { toast('Profile saved.'); route(); } });
}

// =====================================================================
// Sign-up / sign-in: mobile or email + password, with a one-time code at sign-up and
// for "forgot password" (Firebase SMS; email codes when configured on the server)
// =====================================================================
let fb = null;
async function firebase() {
  if (fb) return fb;
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK}/`;
  const [app, mod] = await Promise.all([import(base + 'firebase-app.js'), import(base + 'firebase-auth.js')]);
  const auth = mod.getAuth(app.initializeApp(S.cfg.auth.firebase));
  auth.languageCode = 'en';
  fb = { auth, mod };
  return fb;
}

/**
 * Renders the sign-up / sign-in / forgot-password flow into `host`. Returns a cleanup function.
 * Sign-up and "forgot password" prove the number with a one-time code, then save a password;
 * sign-in is mobile (or email) + password.
 */
function mountAuth(host, { mode = 'signup', autofocus = false, onMode, onDone } = {}) {
  const provider = S.cfg.auth.provider, len = S.cfg.auth.otpLength || 4, emailOk = S.cfg.auth.email;
  const a = { mode, channel: 'phone', name: '', phone: '', email: '', air: '', state: '', password: '', remember: store.get('rr-remember', true) };
  let confirmation = null, verifier = null, timer = null, opened = false;
  const viaFirebase = () => provider === 'firebase' && a.channel === 'phone';
  const shown = () => a.channel === 'email' ? a.email : '+91 ' + a.phone.replace(/(\d{5})(\d{5})/, '$1 $2');
  const profile = () => a.mode === 'signup' ? { name: a.name, air: a.air, state: a.state } : {};
  const contact = () => ({ channel: a.channel, phone: a.phone, email: a.email });
  host.addEventListener('focusin', () => { if (!opened) { opened = true; track('signin_open'); } });
  const resetVerifier = () => { try { verifier?.clear(); } catch { /* already gone */ } verifier = null; };
  // Sign-up details are kept as the code is requested (and the error if sending fails),
  // so a counsellor can still reach the student when the code never arrives.
  const keep = (error = '') => a.mode !== 'signup' ? null : api('/api/auth/attempt', {
    method: 'POST', body: { stage: error ? 'failed' : 'send', ...contact(), ...profile(), error }
  }).catch(() => {});
  // Shown instead of a bare error when the code can't be sent for a set-up reason.
  const unavailable = reason => {
    const wa = waLink(`Hi, I tried to sign up on RankRound but couldn't get the code (${reason}).`);
    return `<div class="alert alert-warn form-err auth-down" role="alert">
      <b>We couldn't send your code just now.</b>
      <span>${a.mode === 'signup'
        ? `Your details are saved, so a counsellor can still reach you on <b class="num">${esc(shown())}</b>. You can also try again in a few minutes.`
        : 'Please try again in a few minutes.'}</span>
      ${wa ? `<a class="btn btn-line btn-sm" href="${esc(wa)}" target="_blank" rel="noopener">${icon.chat} WhatsApp a counsellor</a>` : ''}
      <small>Reference: ${esc(reason)}</small>
    </div>`;
  };

  // ---- Firebase: the password lives on the student's Firebase account, under an address made
  // from the verified number (never shown, never mailed), so it survives server restarts.
  const fbEmail = () => `91${a.phone}@phone.rankround.com`;
  const savePassword = user => user.providerData.some(p => p.providerId === 'password')
    ? fb.mod.updatePassword(user, a.password)
    : fb.mod.linkWithCredential(user, fb.mod.EmailAuthProvider.credential(fbEmail(), a.password));
  async function finishFirebase(user) {
    const r = await api('/api/auth/firebase', { method: 'POST', body: { idToken: await user.getIdToken(), mode: a.mode, remember: a.remember, ...profile() } });
    // The name, ranks and state are kept on the Firebase account too, to restore them after a restart.
    const link = `${location.origin}/profile?${new URLSearchParams({ air: r.user.air || '', cmr: r.user.cmr || '', state: r.user.state || '' })}`;
    await fb.mod.updateProfile(user, { displayName: r.user.name || null, photoURL: link }).catch(() => {});
    fb.mod.signOut(fb.auth).catch(() => {});
    return r;
  }

  // err: a message string, or { setup: reason } when the code couldn't be sent at all.
  function form(err) {
    clearInterval(timer);
    onMode?.(a.mode);
    const up = a.mode === 'signup', reset = a.mode === 'reset', signin = a.mode === 'signin', byCode = a.mode === 'code';
    const what = a.channel === 'email' ? 'email' : 'mobile number';
    host.innerHTML = `
      <form class="auth" novalidate>
        ${reset ? `<p class="auth-intro">Enter your ${what} and a new password. We'll send a one-time code to confirm it's you.</p>` : ''}
        ${byCode ? `<p class="auth-intro">Enter your ${what}. We'll send a one-time code to sign you in.</p>` : ''}
        ${up ? `<label class="field"><span class="label">Full name</span>
          <input class="input" name="name" autocomplete="name" value="${esc(a.name)}" maxlength="80" required></label>` : ''}
        <div class="field"><span class="label">${emailOk ? 'Mobile or email' : 'Mobile number'}${up ? ' <span class="hint">verified with a one-time code</span>' : ''}</span>
          ${emailOk ? `<div class="seg auth-ch" role="group" aria-label="Use">
            <button type="button" data-ch="phone" aria-pressed="${a.channel === 'phone'}">Mobile</button>
            <button type="button" data-ch="email" aria-pressed="${a.channel === 'email'}">Email</button></div>` : ''}
          ${a.channel === 'email'
            ? `<input class="input" name="email" type="email" autocomplete="${signin ? 'username' : 'email'}" placeholder="you@example.com" value="${esc(a.email)}" maxlength="254" aria-label="Email address" required>`
            : `<div class="phone"><span>+91</span><input class="input" name="phone" inputmode="numeric" autocomplete="${signin ? 'username' : 'tel-national'}"
                placeholder="98765 43210" value="${esc(a.phone)}" maxlength="14" aria-label="Mobile number" required></div>`}
        </div>
        ${byCode ? '' : `<div class="field">
          <span class="label pw-label"><span>${reset ? 'New password' : 'Password'}${signin ? '' : ' <span class="hint">at least 8 characters</span>'}</span>
            ${signin ? '<button type="button" class="linkbtn" data-mode="reset">Forgot password?</button>' : ''}</span>
          <div class="pw"><input class="input" name="password" type="password" autocomplete="${signin ? 'current-password' : 'new-password'}"
              value="${esc(a.password)}" maxlength="128" aria-label="${reset ? 'New password' : 'Password'}" required>
            <button type="button" class="pw-show" aria-pressed="false" aria-label="Show password">Show</button></div>
        </div>`}
        ${up ? `<div class="auth-pair">${airField(a.air)}${stateField(a.state)}</div>` : ''}
        <label class="check auth-keep"><input type="checkbox" name="remember" ${a.remember ? 'checked' : ''}> Keep me logged in</label>
        ${err?.setup ? unavailable(err.setup) : err ? `<div class="alert alert-err form-err" role="alert">${err.html || esc(err)}</div>` : ''}
        <button class="btn btn-primary btn-lg auth-go" id="send">${up ? 'Sign up' : signin ? 'Sign in' : 'Send code'} ${icon.arrowR}</button>
        <div class="recaptcha-box"></div>
        <p class="auth-switch">${up
          ? 'Already registered? <button type="button" class="linkbtn" data-mode="signin">Sign in</button>'
          : signin ? 'New here? <button type="button" class="linkbtn" data-mode="signup">Create an account</button>'
          : byCode ? 'Have a password? <button type="button" class="linkbtn" data-mode="signin">Sign in with it</button>'
          : 'Remembered it? <button type="button" class="linkbtn" data-mode="signin">Sign in</button>'}</p>
        ${signin ? '<p class="auth-switch">Or <button type="button" class="linkbtn" data-mode="code">sign in with a one-time code</button></p>' : ''}
        ${up ? `<p class="fine">You'll see cut-offs for the state you choose. By signing up you agree that a counsellor may contact you about PG admissions.</p>` : ''}
      </form>`;
    const f = host.querySelector('form'), el = n => f.elements.namedItem(n);
    if (autofocus) f.querySelector('input').focus();
    f.oninput = e => {
      if (e.target.name === 'remember') a.remember = e.target.checked;
      else if (e.target.name in a) a[e.target.name] = e.target.value;
    };
    $$('[data-ch]', f).forEach(b => b.onclick = () => { a.channel = b.dataset.ch; form(); host.querySelector(`[name="${a.channel}"]`).focus(); });
    $$('[data-mode]', f).forEach(b => b.onclick = () => { a.mode = b.dataset.mode; a.password = ''; a.fallback = false; form(); host.querySelector('input').focus(); });
    if (!byCode) f.querySelector('.pw-show').onclick = e => {
      const on = e.currentTarget.getAttribute('aria-pressed') !== 'true', input = el('password');
      input.type = on ? 'text' : 'password';
      e.currentTarget.setAttribute('aria-pressed', on);
      e.currentTarget.textContent = on ? 'Hide' : 'Show';
      e.currentTarget.setAttribute('aria-label', on ? 'Hide password' : 'Show password');
    };
    f.onsubmit = async e => {
      e.preventDefault();
      if (up) {
        a.name = el('name').value.trim();
        if (a.name.length < 2) return form('Enter your full name.');
      }
      if (a.channel === 'email') {
        a.email = el('email').value.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(a.email)) return form('Enter a valid email address.');
      } else {
        a.phone = el('phone').value.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
        if (!/^[6-9]\d{9}$/.test(a.phone)) return form('Enter a valid 10-digit Indian mobile number.');
      }
      if (!byCode) a.password = el('password').value;
      if (signin && !a.password) return form('Enter your password.');
      if ((up || reset) && a.password.length < 8) return form('Use a password of at least 8 characters.');
      if (up) {
        a.air = el('air').value.replace(/\D/g, '');
        a.state = el('state').value;
        if (!(+a.air > 0)) return form('Enter your NEET-PG rank (All India Rank).');
        if (!a.state) return form('Choose your state.');
      }
      a.remember = el('remember').checked;
      store.set('rr-remember', a.remember);
      const btn = f.querySelector('#send');
      btn.disabled = true;
      if (signin) {
        btn.innerHTML = '<span class="spinner"></span> Signing in';
        try {
          let r;
          if (viaFirebase()) {
            const { auth, mod } = await firebase();
            r = await finishFirebase((await mod.signInWithEmailAndPassword(auth, fbEmail(), a.password)).user);
          } else {
            r = await api('/api/auth/password', { method: 'POST', body: { ...contact(), password: a.password, remember: a.remember } });
          }
          onDone?.();
          await signedIn(r.user, r.isNew);
        } catch (err) {
          // Firebase has password sign-in switched off: the number can still be proven with a code.
          if (viaFirebase() && String(err?.code).endsWith('operation-not-allowed')) {
            a.mode = 'code'; a.fallback = true;
            form(); return host.querySelector('form').requestSubmit();
          }
          form(passwordProblem(err, what));
        }
        return;
      }
      btn.innerHTML = '<span class="spinner"></span> Sending code';
      try {
        await keep();
        if (viaFirebase()) {
          const { auth, mod } = await firebase();
          resetVerifier();
          // Its own container: the home page and the sign-in dialog can both hold a form.
          verifier = new mod.RecaptchaVerifier(auth, f.querySelector('.recaptcha-box'), { size: 'invisible' });
          confirmation = await mod.signInWithPhoneNumber(auth, '+91' + a.phone, verifier);
        } else {
          await api('/api/auth/otp/request', { method: 'POST', body: { mode: a.mode, ...contact(), ...profile() } });
        }
        code();
      } catch (err) {
        resetVerifier();
        const setup = setupProblem(err);
        if (setup) { keep(setup); return form({ setup }); }
        form(firebaseMessage(err) || err.message);
      }
    };
  }

  function code(err) {
    clearInterval(timer);
    host.innerHTML = `
      ${a.fallback ? `<div class="alert alert-info" style="margin-bottom:18px">Password sign-in is unavailable right now, so we've sent you a code instead.</div>` : ''}
      <p class="signin-lead">Enter the ${len}-digit code sent to <b class="num">${esc(shown())}</b>.
        <button class="linkbtn" id="chg">Change</button></p>
      ${provider === 'mock' ? `<div class="alert alert-info" style="margin-bottom:18px">Test mode — no SMS or email is sent. Use code <b class="num">1234</b>.</div>` : ''}
      <form id="s2">
        <div class="otp ${len > 4 ? 'six' : ''}" role="group" aria-label="One-time code">
          ${Array.from({ length: len }, (_, i) => `<input inputmode="numeric" maxlength="1" autocomplete="${i ? 'off' : 'one-time-code'}" aria-label="Digit ${i + 1}">`).join('')}
        </div>
        ${err ? `<div class="alert alert-err form-err">${esc(err)}</div>` : ''}
        <button class="btn btn-primary btn-lg auth-go" id="verify">${a.mode === 'reset' ? 'Verify and save password' : 'Verify and continue'}</button>
        <div class="signin-row"><span id="cd"></span><button type="button" class="linkbtn" id="resend" disabled>Resend code</button></div>
      </form>`;
    const boxes = $$('.otp input', host);
    const value = () => boxes.map(b => b.value).join('');
    boxes[0].focus();
    boxes.forEach((b, i) => {
      b.addEventListener('input', () => {
        b.value = b.value.replace(/\D/g, '').slice(-1);
        if (b.value && i < len - 1) boxes[i + 1].focus();
        if (value().length === len) host.querySelector('#s2').requestSubmit();
      });
      b.addEventListener('keydown', e => { if (e.key === 'Backspace' && !b.value && i) boxes[i - 1].focus(); });
      b.addEventListener('paste', e => {
        const t = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, len);
        if (!t) return;
        e.preventDefault();
        t.split('').forEach((c, j) => { boxes[j].value = c; });
        boxes[Math.min(t.length, len - 1)].focus();
        if (t.length === len) host.querySelector('#s2').requestSubmit();
      });
    });
    host.querySelector('#chg').onclick = () => form();
    let left = 30;
    const cd = host.querySelector('#cd'), rs = host.querySelector('#resend');
    const tick = () => { cd.textContent = left > 0 ? `Resend available in ${left}s` : "Didn't get it?"; rs.disabled = left > 0; left--; };
    tick(); timer = setInterval(() => { tick(); if (left < -1) clearInterval(timer); }, 1000);
    rs.onclick = () => { form(); host.querySelector('form').requestSubmit(); };

    host.querySelector('#s2').onsubmit = async e => {
      e.preventDefault();
      const c = value();
      if (c.length !== len) return;
      const btn = host.querySelector('#verify');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Verifying';
      try {
        let r, saved = true;
        if (viaFirebase()) {
          const cred = await confirmation.confirm(c);
          // The number is proven; a password that can't be saved mustn't keep the student out.
          // A code sign-in after a refused password keeps that password too, once it can be saved.
          if (a.mode !== 'code' || (a.fallback && a.password.length >= 8)) {
            try { await savePassword(cred.user); } catch (err) { saved = a.mode === 'code'; console.error('Password not saved', err?.code || err); }
          }
          r = await finishFirebase(cred.user);
        } else {
          r = await api('/api/auth/otp/verify', { method: 'POST', body: { ...contact(), code: c, password: a.password, remember: a.remember } });
        }
        clearInterval(timer);
        onDone?.();
        await signedIn(r.user, r.isNew);
        if (!saved) toast("You're signed in, but your password couldn't be saved just now. Use “Forgot password” to set it later.", true);
        else if (a.mode === 'reset') toast('New password saved.');
      } catch (err) {
        code(firebaseMessage(err) || err.message);
      }
    };
  }
  form();
  return () => { clearInterval(timer); resetVerifier(); };
}

// A wrong password and an unknown number get the same answer (so numbers can't be probed).
// Accounts made before passwords existed have none yet: "Forgot password" sets one.
function passwordProblem(err, what) {
  const c = String(err?.code || '').replace(/^auth\//, '');
  if (err?.status === 401 || ['invalid-credential', 'invalid-login-credentials', 'wrong-password', 'user-not-found', 'invalid-email'].includes(c))
    return { html: `Wrong ${what} or password. Signed up before passwords were added? Use <b>Forgot password</b> to set one.` };
  if (c === 'too-many-requests') return 'Too many attempts. Try again in a few minutes, or use Forgot password.';
  if (c === 'operation-not-allowed') return 'Password sign-in isn\'t available just yet. Use Forgot password to sign in with a code. (operation-not-allowed)';
  return firebaseMessage(err) || err.message;
}

function openSignIn(then, mode = 'signin') {
  if (then) S.intended = then;
  let stop;
  const d = openDialog(`
    <div class="dialog-head"><h2 id="si-title"></h2><button class="icon-btn" data-close aria-label="Close">${icon.x}</button></div>
    <div class="dialog-body" id="si"></div>`, { onClose: () => stop?.() });
  stop = mountAuth(d.el.querySelector('#si'), {
    mode, autofocus: true, onDone: () => d.close(),
    onMode: m => { d.el.querySelector('#si-title').textContent = { signup: 'Create your free account', reset: 'Reset your password' }[m] || 'Sign in to RankRound'; }
  });
}
// Failures the student can't fix by retyping: the site's set-up or the SMS service.
const SETUP_CODES = new Set(['captcha-check-failed', 'invalid-app-credential', 'missing-app-credential', 'unauthorized-domain',
  'app-not-authorized', 'operation-not-allowed', 'billing-not-enabled', 'quota-exceeded', 'internal-error', 'invalid-api-key',
  'site-not-authorised']);
function setupProblem(err) {
  const c = String(err?.code || '').replace(/^auth\//, '');
  if (SETUP_CODES.has(c)) return c;
  return err?.status >= 500 ? 'server-' + err.status : '';
}
function firebaseMessage(err) {
  const c = err?.code || '';
  if (!c.startsWith('auth/')) return '';
  console.error('Firebase sign-in error', c, err);
  // Mistakes the candidate can fix themselves need no code.
  const own = {
    'auth/invalid-verification-code': 'Incorrect code. Check the SMS and try again.',
    'auth/code-expired': 'That code has expired. Request a new one.',
    'auth/too-many-requests': 'Too many attempts from this device. Try again later.',
    'auth/invalid-phone-number': 'Enter a valid 10-digit Indian mobile number.',
    'auth/network-request-failed': 'Network problem. Check your connection and try again.'
  }[c];
  if (own) return own;
  // Set-up problems on our side: show the code so it can be reported and fixed.
  const setup = {
    'auth/quota-exceeded': 'SMS limit reached for today. Please try again later.',
    'auth/billing-not-enabled': 'SMS sign-in is not available right now. Please try again later.',
    'auth/operation-not-allowed': 'SMS sign-in is not available right now. Please try again later.',
    'auth/unauthorized-domain': 'Sign-in is not enabled on this web address yet.',
    'auth/captcha-check-failed': 'The security check failed. Reload the page and try again.',
    'auth/invalid-app-credential': 'The security check failed. Reload the page and try again.'
  }[c] || 'Sign-in failed. Please try again.';
  return `${setup} (${c.slice(5)})`;
}
async function signedIn(user, isNew) {
  S.user = user;
  S.cfg = await api('/api/config').catch(() => S.cfg);
  S.dsId = { state: null, aiq: null };
  // Each sign-in starts on state counselling, where the CMR given at sign-up is filled in;
  // a shared computer shouldn't carry over the previous student's view.
  S.scope = 'state'; store.set('rr-scope', 'state');
  applyProfile(true);
  await loadShortlist();
  renderTop();
  const first = (user.name || '').split(' ')[0];
  toast(isNew ? `Welcome${first ? ', ' + first : ''}. Your account is ready.` : `Welcome back${first ? ', ' + first : ''}.`);
  const next = S.intended || (GATED.has(location.pathname) ? location.pathname : '/predict');
  S.intended = null;
  S.path = null;
  go(next);
}

// =====================================================================
// Shortlist store
// =====================================================================
async function loadShortlist() {
  try { S.shortlist = (await api('/api/shortlist')).items; } catch { S.shortlist = []; }
  updateCount();
}
function updateCount() {
  const c = $('#slcount');
  if (!c) return;
  c.textContent = S.shortlist.length;
  c.hidden = !S.shortlist.length;
}
const slItem = (kind, k) => S.shortlist.find(i => i.kind === kind && i.key === k);
async function toggleShort(kind, r) {
  const it = slItem(kind, r._k || rowKey(kind, r));
  try {
    if (it) S.shortlist = (await api('/api/shortlist/' + it.id, { method: 'DELETE' })).items;
    else {
      const row = Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_')));
      S.shortlist = (await api('/api/shortlist', { method: 'POST', body: { kind, row, dataset: S.data?.dataset?.label || '' } })).items;
    }
    updateCount();
    toast(it ? 'Removed from shortlist.' : 'Added to shortlist.');
    return !it;
  } catch (e) { toast(e.message, true); return !!it; }
}

// =====================================================================
// Data
// =====================================================================
const setsOf = kind => (S.cfg.datasets || []).filter(d => d.kind === kind);
async function load(kind) {
  const sets = setsOf(kind);
  if (!sets.some(d => d.id === S.dsId[kind])) S.dsId[kind] = sets[0]?.id ?? null;
  const id = S.dsId[kind];
  if (!id) return null;
  if (!S.cache.has(id)) {
    const r = await api('/api/datasets/' + id);
    const rows = r.rows.map(a => Object.fromEntries(r.columns.map((c, i) => [c, a[i]])));
    for (const o of rows) {
      o._k = rowKey(kind, o); o._prog = progOf(kind === 'state' ? o.programme : o.branch);
      if (kind === 'state') o.type = PRIVATE_COLLEGE.test(o.college) ? 'Private' : 'Government';
    }
    S.cache.set(id, {
      dataset: r.dataset, rows,
      openCat: rows.some(o => o.category === 'OPEN') ? 'OPEN' : null, // Gujarat calls its unreserved seats OPEN
      closingOnly: rows.length > 0 && rows.every(closingOnly)
    });
  }
  return S.cache.get(id);
}

const openCatOf = kind => S.data?.openCat || KIND[kind].openCat;
const openCatName = c => ({ UR: 'unreserved (UR)', OPEN: 'open (OPEN)' })[c] || 'General';
function matches(kind, r, f, except) {
  for (const k of KIND[kind].filters) {
    if (k === except) continue;
    const v = f[k];
    if (!v) continue;
    if (k === 'category') {
      if (r.category !== v && !(f.withOpen && r.category === openCatOf(kind))) return false;
    } else if ((k === 'prog' ? r._prog : r[k]) !== v) return false;
  }
  return true;
}
function searchHit(r, q) {
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = Object.values(r).filter(v => typeof v === 'string').join(' ').toLowerCase();
  return terms.every(t => hay.includes(t));
}

// =====================================================================
// Context bar + workspace
// =====================================================================
function ctxbar(kind) {
  const sets = setsOf(kind);
  return `
  <div class="ctxbar"><div class="ctxbar-in">
    <div class="scope" role="group" aria-label="Counselling">
      <button data-scope="state" aria-pressed="${kind === 'state'}"><b>State counselling</b><span>${esc(myState())} · ranked by CMR</span></button>
      <button data-scope="aiq" aria-pressed="${kind === 'aiq'}"><b>All India Quota</b><span>MCC · ranked by NEET AIR</span></button>
    </div>
    <div class="ctx-ds">
      <span class="eyebrow">Dataset</span>
      ${sets.length > 1
        ? `<select class="select" id="ds">${sets.map(d => `<option value="${d.id}" ${d.id === S.dsId[kind] ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}</select>`
        : `<b style="font-weight:500">${esc(sets[0]?.label || 'None published')}</b>`}
    </div>
    <p class="ctx-note"><span id="ctx-note">${esc(KIND[kind].note)}</span>${ctxGuide(kind)}</p>
  </div></div>`;
}
// The student's own counselling guide, next to their data (MCC's for the All India Quota).
function ctxGuide(kind) {
  const region = kind === 'aiq' ? ALL_INDIA : myState();
  return `<a class="ctx-guide" href="/roadmap/${esc(slugOf(region))}" data-link>${esc(kind === 'aiq' ? 'All India roadmap' : `${region} roadmap`)}: dates, guide, merit list, seats ${icon.arrowR}</a>`;
}
function bindCtx() {
  $$('[data-scope]').forEach(b => b.onclick = () => {
    if (S.scope === b.dataset.scope) return;
    S.scope = b.dataset.scope; store.set('rr-scope', S.scope);
    S.shown = STEP;
    route();
  });
  const ds = $('#ds');
  if (ds) ds.onchange = () => { S.dsId[S.scope] = +ds.value; route(); };
}

// Predictions, the cut-off table and the shortlist are three views of "Intelligent prediction".
const WORK_TABS = [['/predict', 'Predictions'], ['/cutoffs', 'Cut-off table'], ['/shortlist', 'Shortlist']];
const workTabs = p => `
  <div class="worktabs"><nav class="worktabs-in" aria-label="Prediction views">${WORK_TABS.map(([href, label]) =>
    `<a href="${href}" data-link${href === p ? ' aria-current="page"' : ''}>${label}${href === '/shortlist' ? ' <span class="count num" id="slcount" hidden></span>' : ''}</a>`).join('')}
  </nav></div>`;

// ---- counselling roadmap (guides.json "roadmap"), above the predictions ----
const shortDay = ms => new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
const stageSpan = s => `${shortDay(s.a)} – ${shortDay(s.b)}`;
function stagesNow(rm, now = Date.now()) {
  const st = rm.stages.map(s => ({ ...s, a: Date.parse(s.from), b: Date.parse(s.to) }));
  const at = st.findIndex(s => now <= s.b); // the first stage not yet over
  st.forEach((s, i) => { s.state = at < 0 || i < at ? 'done' : i > at ? 'upcoming' : now >= s.a ? 'current' : 'next'; });
  return { st, cur: at < 0 ? null : st[at] };
}
function roadmapIcs(rm) {
  const d = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const txt = s => String(s).replace(/[\\;,]/g, m => '\\' + m).replace(/\n/g, '\\n');
  const ev = rm.stages.map((s, i) => ['BEGIN:VEVENT', `UID:rankround-2026-${i}@rankround`, `DTSTAMP:${d(Date.now())}`,
    `DTSTART:${d(Date.parse(s.from))}`, `DTEND:${d(Date.parse(s.to))}`, `SUMMARY:${txt('NEET-PG counselling: ' + s.name)}`,
    `DESCRIPTION:${txt(s.detail || '')}`, 'BEGIN:VALARM', 'TRIGGER:-P1D', 'ACTION:DISPLAY', `DESCRIPTION:${txt(s.name)}`, 'END:VALARM', 'END:VEVENT']);
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RankRound//Counselling roadmap//EN', ...ev.flat(), 'END:VCALENDAR'].join('\r\n');
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([ics], { type: 'text/calendar' })), download: 'neet-pg-2026-counselling.ics' });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function renderRoadmap() {
  try { S.guideIndex ||= await api('/api/guides'); } catch { /* the predictions work without it */ }
  const box = $('#roadmap'), rm = S.guideIndex?.roadmap;
  if (!box) return;
  if (!rm?.stages?.length) { box.remove(); return; }
  const { st, cur } = stagesNow(rm);
  const open = !store.get('rr-roadmap-closed', false);
  const PILL = { done: 'Done', current: 'Current stage', next: 'Next', upcoming: 'Upcoming' };
  // The student's own state dates still to come, then this stage's MCC events.
  const steps = S.guideIndex.guides.filter(x => x.region === myState()).flatMap(x => (x.dates || []).map(d => ({ ...d, slug: x.slug })))
    .map(d => ({ d, s: stepStatus(d) })).filter(x => x.s.tone !== 'done' && x.s.tone !== 'info').slice(0, 3);
  const ds = S.data?.dataset?.label || '';
  box.innerHTML = `
    <div class="rm-head">
      <div><div class="eyebrow">Counselling 2026 › Roadmap</div><h2>${esc(rm.title)}</h2></div>
      <button class="btn btn-line btn-sm" id="rm-toggle" aria-expanded="${open}" aria-controls="rm-body">${open ? 'Hide roadmap' : 'Show roadmap'}</button>
    </div>
    <ol class="rm-steps">${st.map((s, i) => `
      <li class="${s.state}"${s.state === 'current' || s.state === 'next' ? ' aria-current="step"' : ''}>
        <span class="rm-dot">${s.state === 'done' ? '✓' : i + 1}</span>
        <b>${esc(s.name)}</b><small>${stageSpan(s)}</small><em>${PILL[s.state]}</em>
      </li>`).join('')}
    </ol>
    <div class="rm-body" id="rm-body"${open ? '' : ' hidden'}>
      <div class="rm-card rm-now">
        ${cur ? `<span class="gd-pill ${cur.state === 'current' ? 'open' : 'soon'}">${cur.state === 'current' ? 'Current stage' : 'Next stage'}</span>
          <h3>${esc(cur.name)} <small>${stageSpan(cur)}</small></h3><p>${esc(cur.detail || '')}</p>`
          : '<h3>NEET-PG 2026 counselling has finished</h3><p>Check your state authority for any special stray rounds.</p>'}
        <div class="rm-links">
          <a class="btn btn-primary btn-sm" href="/roadmap/${esc(slugOf(myState()))}" data-link>${esc(myState())} roadmap ${icon.arrowR}</a>
          <a class="btn btn-line btn-sm" href="/roadmap/all-india" data-link>All India roadmap ${icon.arrowR}</a>
        </div>
      </div>
      <div class="rm-card rm-dates">
        <h3>Important dates <small>Upcoming events</small></h3>
        <ul>${steps.map(({ d, s }) => `<li><a href="/roadmap/${esc(slugOf(myState()))}" data-link>${esc(myState())}: ${esc(d.what)}</a><span>${esc(d.when)}</span><span class="gd-pill ${s.tone}">${esc(s.text)}</span></li>`).join('')}
          ${(cur?.events || []).map(e => `<li><b>${esc(e.what)}</b><span>${esc(e.when)}</span></li>`).join('')}</ul>
        <button class="btn btn-line btn-sm" id="rm-ics">${icon.download} Set reminders (calendar)</button>
      </div>
      <div class="rm-card rm-pred">
        <h3>Predictions</h3>
        <div class="rm-pred-row"><div><b>Pre-counselling predictor</b> <span class="gd-pill open">Available</span>
          <p>Based on previous year closing ranks${ds ? ` · ${esc(ds)}` : ''}.</p></div>
          <a class="btn btn-line btn-sm" href="#res" id="rm-view">View prediction ${icon.down}</a></div>
        ${S.cfg.regionData?.[myState()]?.includes('seats') ? `<div class="rm-pred-row"><div><b>${esc(myState())} Round 1: your chance at every seat</b> <span class="gd-pill info">New</span>
          <p>This year's seat matrix, each seat graded against last year's closing rank for your CMR.</p></div>
          <a class="btn btn-line btn-sm" href="/roadmap/${esc(slugOf(myState()))}/round-1/choice-filling" data-link>Open the seat matrix ${icon.arrowR}</a></div>` : ''}
        ${S.cfg.regionData?.[ALL_INDIA]?.includes('allotment') ? `<div class="rm-pred-row"><div><b>MCC Round 1 result</b> <span class="gd-pill info">New</span>
          <p>Every seat allotted in Round 1, searchable by All India Rank, college, course, quota and Govt / private.</p></div>
          <a class="btn btn-line btn-sm" href="/roadmap/all-india/round-1/allotment" data-link>Open the result ${icon.arrowR}</a></div>` : ''}
      </div>
      <p class="rm-src">${esc(rm.source || '')}</p>
    </div>`;
  $('#rm-toggle').onclick = () => { store.set('rr-roadmap-closed', open); renderRoadmap(); track('roadmap', { open: !open }); };
  $('#rm-ics').onclick = () => { roadmapIcs(rm); track('export', { mode: 'roadmap-ics' }); };
  $('#rm-view').onclick = e => { e.preventDefault(); $('#res')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
}

async function viewWork(mode) {
  const kind = S.scope;
  S.mode = mode;
  S.shown = STEP;
  view.innerHTML = workTabs(S.path) + ctxbar(kind) + `
    <div class="workspace">
      <aside class="rail" id="rail" aria-label="Filters"></aside>
      <div class="work-main">${mode === 'predict' ? '<section class="roadmap" id="roadmap" aria-label="Counselling roadmap"></section>' : ''}
        <section class="results" id="res"><div class="empty"><span class="spinner"></span></div></section></div>
    </div>`;
  updateCount();
  bindCtx();
  let data;
  try { data = await load(kind); }
  catch (e) {
    if (e.status === 401) { S.user = null; renderTop(); return route(); }
    $('#res').innerHTML = `<div class="empty"><h3>Couldn't load the data</h3><p>${esc(e.message)}</p></div>`; return;
  }
  if (S.mode !== mode || S.scope !== kind) return;
  if (!data) {
    $('#rail').hidden = true;
    $('.workspace').classList.add('no-rail');
    const have = (kind === 'state' ? S.cfg.stateData : S.cfg.dataStates) || [];
    const other = kind === 'state' && setsOf('aiq').length;
    const wa = waLink(`Hi, I would like help with ${myState()} PG counselling.`);
    $('#res').innerHTML = `<div class="empty">
      <h3>${esc(myState())} ${kind === 'state' ? 'state counselling' : 'All India Quota'} data is coming soon</h3>
      <p>We're adding states one at a time${have.length ? ` — ${kind === 'state' ? 'state counselling ' : ''}cut-offs are live for ${esc(have.join(', '))}` : ''}.
        ${other ? `<b>All India Round 1 cut-offs for ${esc(myState())} are ready now.</b>` : `Your sign-up is saved, and ${esc(myState())} data will appear here as soon as it is published.`}</p>
      <div class="empty-actions">${other ? '<button class="btn btn-primary" id="to-aiq">See All India cut-offs</button>' : ''}${guidesFor(myState()).length
        ? `<a class="btn btn-line" href="/counselling/${esc(guidesFor(myState())[0].slug)}">${esc(myState())} counselling guide</a>`
        : '<a class="btn btn-line" href="/counselling" data-link>Counselling guides</a>'}
        <button class="btn btn-line" id="chg-state">Change state</button>
        ${wa ? `<a class="btn btn-primary" href="${esc(wa)}" target="_blank" rel="noopener">${icon.chat} Talk to a counsellor</a>` : ''}</div>
    </div>`;
    $('#chg-state').onclick = editProfile;
    if ($('#to-aiq')) $('#to-aiq').onclick = () => { S.scope = 'aiq'; store.set('rr-scope', 'aiq'); S.shown = STEP; route(); };
    if (mode === 'predict') renderRoadmap();
    return;
  }
  S.data = data;
  // A filter saved on another dataset ("MD - Radio Diagnosis" in 2025, "MD Radio Diagnosis" in 2026) would match nothing here.
  const f = S.f[kind];
  for (const k of KIND[kind].filters) if (f[k] && k !== 'stream' && !data.rows.some(r => (k === 'prog' ? r._prog : r[k]) === f[k])) f[k] = '';
  $('#ctx-note').textContent = KIND[kind].note; // the note depends on the dataset just loaded
  renderRail();
  renderResults();
  if (mode === 'predict') renderRoadmap();
}

// ---- filter rail -------------------------------------------------------
function optionsFor(kind, field) {
  const f = S.f[kind];
  const vals = uniq(S.data.rows.filter(r => matches(kind, r, f, field)).map(r => r[field]));
  if (f[field] && !vals.includes(f[field])) vals.push(f[field]);
  return vals.sort((a, b) => a.localeCompare(b));
}
const selectHtml = (kind, field) => {
  const v = S.f[kind][field];
  return `<option value="">${ALL_LABEL[field]}</option>` + optionsFor(kind, field)
    .map(o => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('');
};
function railSummary(kind) {
  const f = S.f[kind];
  const bits = KIND[kind].filters.filter(k => k !== 'stream' && f[k]).map(k => f[k]);
  return bits.join(' · ') || 'None set';
}

function renderRail() {
  const kind = S.scope, K = KIND[kind], f = S.f[kind];
  const rail = $('#rail');
  const collapsed = rail.dataset.init === '1' ? rail.classList.contains('collapsed') : true;
  rail.dataset.init = '1';
  rail.classList.toggle('collapsed', collapsed);
  rail.innerHTML = `
    <div class="rail-sec">
      ${S.mode === 'predict' ? `
        <label class="label" for="f-rank">Your ${K.rankLong}</label>
        <input class="input input-rank" id="f-rank" inputmode="numeric" autocomplete="off" placeholder="${kind === 'state' ? 'e.g. 250' : 'e.g. 25000'}" value="${esc(f.rank)}">
        ${kind === 'state' ? '<div class="cf-box" id="cmr-help"></div>' : ''}
      ` : `
        <label class="label" for="f-q">Search</label>
        <div class="search-wrap">${icon.search}<input class="input" id="f-q" type="search" autocomplete="off" placeholder="College, speciality, category" value="${esc(f.q)}"></div>
      `}
      ${progSeg(kind)}
      ${kind === 'state' ? `
        <div class="field" style="margin-top:16px"><span class="label">Stream</span>
          <div class="seg" role="group" aria-label="Stream">
            ${STREAMS.map(([v, t]) =>
              `<button data-stream="${v}" aria-pressed="${f.stream === v}">${t}</button>`).join('')}
          </div>
        </div>
        ${S.data.closingOnly
          ? `<p class="note">Figures are the <b>last rank admitted</b> in the final round; earlier rounds closed tighter. Pick a quota under More filters.</p>`
          : `<p class="note">Direct and in-service candidates have <b>separate merit lists</b> — the CMR restarts at 1 in each. Compare only within your stream.</p>`}
      ` : ''}
    </div>
    <button class="rail-toggle" id="rtog" aria-expanded="${!collapsed}">More filters <span id="rsum">${esc(railSummary(kind))}</span></button>
    <div class="rail-sec fold">
      <div class="rail-title"><h3>Refine</h3><button class="linkbtn" id="f-reset">Reset all</button></div>
      <label class="field"><span class="label">Category</span><select class="select" data-f="category">${selectHtml(kind, 'category')}</select></label>
      <label class="check" id="wopen" ${f.category && f.category !== openCatOf(kind) ? '' : 'hidden'}>
        <input type="checkbox" id="f-open" ${f.withOpen ? 'checked' : ''}>
        <span>Also show ${openCatName(openCatOf(kind))} seats — reserved-category candidates compete for these on merit too.</span>
      </label>
      ${K.filters.filter(k => !['stream', 'prog', 'category'].includes(k) && (!OPTIONAL_FILTERS.includes(k) || optionsFor(kind, k).length)).map(k => `
        <label class="field"><span class="label">${FILTER_LABEL[k]}</span>
          ${k === 'type'
            ? `<select class="select" data-f="type">${['', 'Government', 'Private'].map(v => `<option value="${v}" ${f.type === v ? 'selected' : ''}>${v || ALL_LABEL.type}</option>`).join('')}</select>`
            : `<select class="select" data-f="${k}">${selectHtml(kind, k)}</select>`}
        </label>`).join('')}
    </div>
    ${S.mode === 'predict' ? `
    <div class="rail-sec fold">
      <div class="rail-title"><h3>Reading the chance</h3></div>
      ${[4, 3, 2, 1].map(b => `<div class="band b${b}" style="font-size:12.5px;margin-bottom:8px"><i></i>${BAND[b]}
        <span class="muted" style="font-weight:400">— ${['', 'within 15% past the closing rank', 'in the back half of the range', 'in the front half of the range', 'better than the opening rank'][b]}</span></div>`).join('')}
    </div>` : ''}`;

  $('#rtog').onclick = () => { const c = rail.classList.toggle('collapsed'); $('#rtog').setAttribute('aria-expanded', String(!c)); };
  const changed = (refreshOptions = true) => {
    saveFilters();
    if (refreshOptions) refreshSelects();
    $('#rsum').textContent = railSummary(kind);
    S.shown = STEP;
    renderResults();
  };
  const rank = $('#f-rank');
  if (rank) {
    const go = debounce(() => changed(false), 220);
    rank.oninput = () => { rank.value = rank.value.replace(/\D/g, '').slice(0, 7); f.rank = rank.value; go(); };
    rank.onkeydown = e => { if (e.key === 'Enter') { rank.blur(); changed(false); } };
    if (!f.rank && !matchMedia('(max-width:960px)').matches) rank.focus();
  }
  const q = $('#f-q');
  if (q) { const go = debounce(() => changed(false), 200); q.oninput = () => { f.q = q.value; go(); }; }
  if ($('#cmr-help')) cmrFinder($('#cmr-help'), myState(), { typed: () => $('#f-rank').value, onSet: () => { renderRail(); renderResults(); } });
  $$('[data-prog]').forEach(b => b.onclick = () => {
    f.prog = b.dataset.prog;
    $$('[data-prog]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    changed();
  });
  $$('[data-stream]').forEach(b => b.onclick = () => {
    f.stream = b.dataset.stream;
    $$('[data-stream]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    changed();
  });
  $$('select[data-f]', rail).forEach(s => s.onchange = () => {
    f[s.dataset.f] = s.value;
    if (s.dataset.f === 'category') $('#wopen').hidden = !(s.value && s.value !== openCatOf(kind));
    changed();
  });
  $('#f-open').onchange = e => { f.withOpen = e.target.checked; changed(); };
  $('#f-reset').onclick = () => {
    const keep = { rank: f.rank, q: '' };
    S.f[kind] = Object.assign(freshFilters()[kind], S.mode === 'predict' ? keep : {});
    saveFilters();
    renderRail(); renderResults();
  };
}
// MD/MS, DNB and diploma as one row of buttons; a programme the dataset doesn't have is disabled.
function progSeg(kind) {
  const f = S.f[kind], have = new Set(S.data.rows.map(r => r._prog));
  if (f.prog && !have.has(f.prog)) f.prog = '';
  return `<div class="field" style="margin-top:16px"><span class="label">Programme</span>
    <div class="seg seg-prog" role="group" aria-label="Programme">${[['', 'All'], ...PROGS.map(p => [p, p])].map(([v, t]) =>
      `<button data-prog="${v}" aria-pressed="${f.prog === v}"${v && !have.has(v) ? ' disabled title="Not in this dataset"' : ''}>${t}</button>`).join('')}</div></div>`;
}
function refreshSelects() {
  const kind = S.scope;
  $$('#rail select[data-f]').forEach(s => { if (s.dataset.f !== 'type') s.innerHTML = selectHtml(kind, s.dataset.f); });
}

// ---- results -----------------------------------------------------------
function posSvg(open, close, rank, w = 100) {
  const max = Math.max(close * 1.15, rank) * 1.06;
  const x = v => 2 + (v / max) * (w - 4);
  const x0 = x(open), x1 = Math.max(x(close), x0 + 2);
  return `<svg width="${w}" height="16" viewBox="0 0 ${w} 16" aria-hidden="true">
    <line class="trk" x1="2" x2="${w - 2}" y1="8" y2="8"/>
    <rect class="rng" x="${x0.toFixed(1)}" y="4.5" width="${(x1 - x0).toFixed(1)}" height="7"/>
    <rect class="you" x="${(x(rank) - 1).toFixed(1)}" y="0" width="2" height="16"/></svg>`;
}
const bandHtml = b => b ? `<span class="band chip b${b}"><i></i>${BAND[b]}</span>` : '';
const starHtml = (kind, r) => {
  const on = !!slItem(kind, r._k);
  return `<button class="star" data-star aria-pressed="${on}" aria-label="${on ? 'Remove from' : 'Add to'} shortlist">${on ? icon.starFill : icon.star}</button>`;
};

function columns(kind, mode, rank) {
  const K = KIND[kind];
  const c = [{ id: 'star', t: '<span class="sr">Shortlist</span>', cls: 'nowrap', r: r => starHtml(kind, r) }];
  if (mode === 'predict') c.push({ id: 'band', t: 'Chance', v: r => r._b, num: true, cls: 'nowrap', r: r => bandHtml(r._b) });
  c.push({ id: 'college', t: 'College', v: r => shortCollege(r.college), cls: 'strong wrapcell',
    r: r => `<span title="${esc(r.college)}">${esc(shortCollege(r.college))}</span><span class="sub">${esc(kind === 'aiq' ? poolOf(kind, r) : r.type)}</span>` });
  c.push({ id: 'spec', t: K.specLabel, v: r => r[K.spec], cls: 'wrapcell',
    r: r => esc(r[K.spec]) + (kind === 'state' ? `<span class="sub">${esc(r.programme)} · ${esc(r.rounds || 'R-?')}</span>` : '') });
  c.push({ id: 'category', t: 'Category', v: r => r.category + seatPool(r), cls: 'nowrap',
    r: r => esc(r.category) + (kind === 'state' ? `<span class="sub">${esc(seatPool(r))}</span>` : '') });
  const p = mode === 'predict';
  c.push({ id: 'open', t: p ? 'Open' : `${K.rank} open`, v: r => r[K.open], num: true, cls: 'n soft', r: r => closingOnly(r) ? '—' : fmt(r[K.open]) });
  c.push({ id: 'close', t: p ? 'Close' : `${K.rank} close`, v: r => r[K.close], num: true, cls: 'n',
    r: r => fmt(r[K.close]) + (p ? `<span class="sub">${closingOnly(r) ? 'last admitted' : `${r.seats} seat${r.seats === 1 ? '' : 's'}`}</span>` : '') });
  if (mode === 'predict') {
    c.push({ id: 'margin', t: 'Margin', v: r => r._m, num: true, cls: 'n',
      r: r => `<span class="${r._m >= 0 ? 'margin-pos' : 'margin-neg'}" title="${r._m >= 0 ? 'ranks inside' : 'ranks past'} the closing rank">${r._m >= 0 ? '+' : '−'}${fmt(Math.abs(r._m))}</span>` });
    c.push({ id: 'pos', t: 'Position', cls: 'pos nowrap', r: r => posSvg(r[K.open], r[K.close], rank) });
    return c;
  }
  if (kind === 'state') c.push({ id: 'air', t: 'NEET AIR', v: r => r.air_close, num: true, cls: 'n soft',
    r: r => r.air_open ? (r.air_open === r.air_close ? fmt(r.air_open) : `${fmt(r.air_open)}–${fmt(r.air_close)}`) : '—' });
  c.push({ id: 'seats', t: 'Seats', v: r => r.seats, num: true, cls: 'n soft', r: r => r.seats ? fmt(r.seats) : '—' });
  return c;
}

const trackPredict = debounce((kind, f, n) => track('predict', {
  scope: kind, rank: +f.rank, stream: kind === 'state' ? f.stream : '', category: f.category, programme: f.programme || '',
  spec: f.speciality || f.branch || '', college: f.college, type: f.type || '', results: n
}), 1500);
const trackSearch = debounce((kind, f, n) => track('search', {
  scope: kind, q: f.q, category: f.category, spec: f.speciality || f.branch || '', college: f.college, results: n
}), 1500);

function renderResults() {
  const kind = S.scope, K = KIND[kind], f = S.f[kind], mode = S.mode;
  const res = $('#res');
  const rank = parseInt(f.rank, 10);
  if (mode === 'predict' && !(rank > 0)) {
    res.innerHTML = `
      <div class="res-head"><div><div class="eyebrow">Predictor · ${esc(S.data.dataset.label)}</div>
        <div class="res-count"><strong>Enter your rank</strong></div>
        <p class="res-sub">Type your ${esc(K.rankLong)} in the panel. We'll list every seat it reached in ${S.data.dataset.year}, graded by how comfortably.</p></div></div>
      <div class="empty" style="text-align:left;padding:28px 0">
        <p class="muted" style="max-width:62ch;line-height:1.65">${kind === 'state'
          ? `Your CMR is the rank on the ${esc(myState())} state merit list — not your NEET-PG rank (All India Rank). ${S.cfg.regionData?.[myState()]?.includes('merit')
            ? `Use “Find my CMR” in the panel: we look your NEET-PG rank up on the ${esc(myState())} merit list.` : 'Type it from the state merit list once it is out.'} Pick your stream (direct or in-service) too: the two lists are numbered separately.`
          : 'All India Quota seats are allotted by the MCC on your NEET All India Rank. Candidates from every state compete for these seats.'}</p>
      </div>`;
    return;
  }

  let list = S.data.rows.filter(r => matches(kind, r, f) && (mode !== 'cutoffs' || searchHit(r, f.q)));
  const tally = { 4: 0, 3: 0, 2: 0, 1: 0 };
  if (mode === 'predict') {
    list = list.filter(r => {
      r._b = grade(rank, r, K);
      r._m = r[K.close] - rank;
      if (r._b) tally[r._b]++;
      return r._b > 0;
    });
    trackPredict(kind, f, list.length);
  } else if (f.q || f.college || f.category) trackSearch(kind, f, list.length);

  const cols = columns(kind, mode, rank);
  const sk = mode + kind;
  const srt = S.sort[sk] || (mode === 'predict' ? { id: 'band', dir: -1 } : { id: 'close', dir: 1 });
  const col = cols.find(c => c.id === srt.id) || cols.find(c => c.id === 'close');
  list.sort((a, b) => {
    const x = col.v(a), y = col.v(b);
    const d = col.num ? (x || 0) - (y || 0) : String(x).localeCompare(String(y));
    return d * srt.dir || a[K.close] - b[K.close];
  });
  S.list = list; S.cols = cols;

  const total = list.length;
  const who = [kind === 'state' ? f.quota || f.stream : '', f.prog, f.category ? f.category + (f.withOpen && f.category !== openCatOf(kind) ? ` + ${openCatOf(kind)}` : '') : 'all categories']
    .filter(Boolean).join(' · ');
  const head = mode === 'predict' ? `
      <div><div class="eyebrow">Seats in reach · ${esc(S.data.dataset.label)}</div>
        <div class="res-count"><strong>${fmt(total)}</strong><span>at ${K.rank} <b class="num">${fmt(rank)}</b> · ${esc(who)}</span></div>
        <p class="res-sub">Seats whose ${S.data.dataset.year} closing rank was at or past yours, plus stretch seats up to 15% beyond it.</p></div>`
    : `
      <div><div class="eyebrow">Cut-off table · ${esc(S.data.dataset.label)}</div>
        <div class="res-count"><strong>${fmt(total)}</strong><span>of ${fmt(S.data.rows.length)} seat groups · ${esc(who)}</span></div>
        <p class="res-sub">Opening and closing ${K.rank} admitted to each college, ${K.specLabel.toLowerCase()} and category. Click a row for detail.</p></div>`;

  const dist = mode === 'predict' && total ? `
    <div class="dist">
      <div class="dist-bar" role="img" aria-label="${[4, 3, 2, 1].map(b => `${tally[b]} ${BAND[b]}`).join(', ')}">
        ${[4, 3, 2, 1].filter(b => tally[b]).map(b => `<i class="b${b}" style="flex:${tally[b]}" title="${BAND[b]}: ${tally[b]}"></i>`).join('')}
      </div>
      <div class="dist-legend">${[4, 3, 2, 1].map(b => `<span><i class="b${b}"></i>${BAND[b]} <b>${tally[b]}</b></span>`).join('')}</div>
    </div>` : '<div style="height:16px"></div>';

  res.innerHTML = `
    <div class="res-head">${head}</div>
    ${dist}
    ${total && mobile.matches ? `
    <div class="sortbar"><label class="eyebrow" for="msort">Sort</label>
      <select class="select" id="msort">${cols.filter(c => c.v).map(c => `<option value="${c.id}" ${c.id === srt.id ? 'selected' : ''}>${c.t.replace(/<[^>]+>/g, '')}</option>`).join('')}</select></div>
    <div class="cards" id="tb"></div>
    <div class="more" id="more" hidden></div>` : total ? `
    <div class="grid-wrap"><table class="grid">
      <thead><tr>${cols.map(c => `<th scope="col" data-col="${c.id}" class="${c.v ? 'sortable' : ''} ${c.num ? 'r' : ''}"
        ${c.id === srt.id ? `aria-sort="${srt.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${c.t}${c.v ? `<span class="ar">${c.id === srt.id ? (srt.dir > 0 ? '▲' : '▼') : ''}</span>` : ''}</th>`).join('')}</tr></thead>
      <tbody id="tb"></tbody>
    </table></div>
    <div class="more" id="more" hidden></div>` : `
    ${mode === 'predict' ? outOfReach(kind, rank) : `<div class="grid-wrap"><div class="empty"><h3>Nothing matches</h3><p>Try a different search or clear some filters.</p></div></div>`}`}`;

  $$('th.sortable', res).forEach(th => th.onclick = () => {
    const id = th.dataset.col;
    const c = cols.find(x => x.id === id);
    S.sort[sk] = { id, dir: srt.id === id ? -srt.dir : (c.num && (id === 'band' || id === 'margin') ? -1 : 1) };
    S.shown = STEP;
    renderResults();
  });
  const ms = $('#msort');
  if (ms) ms.onchange = () => {
    const c = cols.find(x => x.id === ms.value);
    S.sort[sk] = { id: c.id, dir: c.num && (c.id === 'band' || c.id === 'margin') ? -1 : 1 };
    renderResults();
  };
  if (total) { drawRows(true); bindRows(); }
  $('#to-aiq2')?.addEventListener('click', () => { S.scope = 'aiq'; store.set('rr-scope', 'aiq'); S.shown = STEP; route(); });
  $$('[data-near]', res).forEach(el => el.onclick = () => openSeat(kind, S.near[+el.dataset.near]));
}

// No seat in reach. Say why: the rank is past every closing rank in this selection (often an All India
// Rank typed as a state CMR), or the filters leave nothing. Show the seats that went furthest anyway.
// ---- the state CMR -------------------------------------------------------------
// The state CMR is the rank on the state merit list, not the NEET-PG rank. Where we hold the merit list, it is
// found there from the NEET-PG rank (or the name); elsewhere the candidate types it. Either way it is saved.
async function meritOf(region) {
  if (S.user?.state !== region || !S.cfg.regionData?.[region]?.includes('merit')) return null;
  const info = await regionInfo(slugOf(region)), d = info.data.find(x => x.kind === 'merit');
  S.rpData ||= {};
  return S.rpData[info.key + '/' + d.id] ||= await api(`/api/regions/${info.key}/data/${d.id}`);
}
async function saveCmr(cmr, stream) {
  S.user = (await api('/api/me', { method: 'PATCH', body: { cmr } })).user;
  S.f.state.rank = String(cmr);
  if (stream === 'Direct' || stream === 'In-service') S.f.state.stream = stream;
  saveFilters(); renderTop();
  toast(`Saved: your ${S.user.state} CMR is ${fmt(cmr)}.`);
}
/** typed(): the rank typed next to it (states without a merit list); onSet(cmr) after saving. */
function cmrFinder(box, region, { typed, onSet } = {}) {
  if (S.user?.state !== region) { box.innerHTML = ''; return; }
  const list = S.cfg.regionData?.[region]?.includes('merit');
  const saved = S.user.cmr ? `Saved CMR: <b class="num">${fmt(S.user.cmr)}</b>. ` : '';
  const use = (cmr, stream) => saveCmr(cmr, stream).then(() => onSet?.(cmr, stream)).catch(e => toast(e.message, true));
  if (!list) {
    box.innerHTML = `<p>${saved}Your <b>${esc(region)} CMR</b> is your rank on the state merit list, not your NEET-PG rank.
      ${typed ? '<button type="button" class="linkbtn" id="cf-keep">Save the rank above as my CMR</button>' : ''}</p>`;
    $('#cf-keep', box)?.addEventListener('click', () => { const n = parseInt(typed(), 10); if (n > 0) use(n); else toast('Type your state CMR first.', true); });
    return;
  }
  box.innerHTML = `<p>${saved}Your <b>${esc(region)} CMR</b> is your rank on the ${esc(region)} merit list, not your NEET-PG rank.</p>
    <button type="button" class="btn btn-line btn-sm" id="cf-go">${icon.search} Find my CMR${S.cfg.meritByName?.includes(region) ? ' by name'
      : S.user.air ? ` from NEET-PG rank ${fmt(S.user.air)}` : ''}</button>
    <div class="cf-out" id="cf-out" aria-live="polite"></div>`;
  const out = $('#cf-out', box);
  const show = (hits, note) => {
    out.innerHTML = (note ? `<p>${note}</p>` : '') + hits.slice(0, 6).map(({ r, l }, i) => `<div class="cf-hit"><div><b>${esc(r.name || `Application no. ${r.app}`)}</b>
        <small>${[`${esc(l.label)}${/\blist\b/i.test(l.label) ? '' : ' list'}`, r.air && `NEET-PG rank ${fmt(r.air)}`, r.cat && esc(r.cat.replace(/,.*$/, '')), r.sub && esc(r.sub)].filter(Boolean).join(' · ')}</small></div>
      ${rejectedList(l) ? `<span class="rp-bad">${esc(r.reason || 'Rejected')}</span>`
        : `<button type="button" class="btn btn-primary btn-sm" data-hit="${i}">Use CMR ${esc(stateRank(r))}</button>`}</div>`).join('')
      + (named ? `<label class="cf-name">Not you? Search the list by name<input class="input" id="cf-q" type="search" autocomplete="off" placeholder="Your name as on the merit list"></label>`
        : `<label class="cf-name">Not you? Search the list by application or NEET roll no.<input class="input" id="cf-q" type="search" inputmode="numeric" autocomplete="off" placeholder="e.g. 2601529"></label>`);
    $$('[data-hit]', out).forEach(b => b.onclick = () => { const { r, l } = hits[+b.dataset.hit]; use(r.ranks.UR, l.type); });
    const q = $('#cf-q', out);
    q.oninput = debounce(() => {
      const terms = q.value.toLowerCase().split(/\s+/).filter(t => t.length > 1);
      if (!terms.length) return;
      const found = all.filter(({ r }) => named ? terms.every(t => (r.name || '').toLowerCase().includes(t)) : terms.some(t => t === r.app || t === r.roll));
      show(found, found.length ? `${fmt(found.length)} on the list for “${esc(q.value)}”${found.length > 6 ? ' (first 6)' : ''}:`
        : named ? `No one called “${esc(q.value)}” on the list.` : `No candidate with number “${esc(q.value)}” on the list.`);
      const nq = $('#cf-q', out); nq.value = q.value; nq.focus();
    }, 300);
  };
  let all = [], named = true;
  $('#cf-go', box).onclick = async () => {
    out.innerHTML = '<span class="spinner"></span>';
    try { all = (await meritOf(region)).lists.flatMap(l => l.rows.map(r => ({ r, l }))); named = all.some(({ r }) => r.name); }
    catch (e) { out.innerHTML = `<p>${esc(e.message)}</p>`; return; }
    // some states (Tamil Nadu) publish no NEET-PG ranks: then the name is the way in
    const byAir = all.some(({ r }) => r.air);
    const hits = S.user.air && byAir ? all.filter(({ r }) => r.air === S.user.air) : [];
    show(hits, hits.length ? 'Found you on the merit list:' : !byAir ? `The ${esc(region)} list doesn't show NEET-PG ranks: search it by your name.`
      : S.user.air ? `NEET-PG rank ${fmt(S.user.air)} isn't on the ${esc(region)} merit list.` : '');
  };
}

function outOfReach(kind, rank) {
  const K = KIND[kind], f = S.f[kind], ds = S.data.dataset;
  const base = S.data.rows.filter(r => matches(kind, r, f));
  if (!base.length) return `<div class="grid-wrap"><div class="empty"><h3>No ${ds.year} seats match these filters</h3>
    <p>Clear a filter or two${kind === 'state' ? ', or check your stream' : ''}.</p></div></div>`;
  S.near = [...base].sort((a, b) => b[K.close] - a[K.close]).slice(0, 8);
  const last = S.near[0][K.close];
  const merit = kind === 'state' && S.cfg.regionData?.[myState()]?.includes('merit');
  const hint = kind === 'state' && rank > last
    ? `<p>Your CMR is your rank on the <b>${esc(myState())} state merit list</b>, not your NEET All India Rank.${merit
      ? ` <a href="/roadmap/${esc(slugOf(myState()))}/merit-list" data-link>Find your CMR on the ${esc(myState())} merit list</a>.` : ''}
      To see where your NEET AIR reaches, use the All India Quota.</p>
      <div class="empty-actions"><button class="btn btn-primary btn-sm" id="to-aiq2">Use my NEET AIR in the All India Quota</button></div>` : '';
  return `<div class="grid-wrap"><div class="empty oor">
      <h3>${rank > last ? `${K.rank} ${fmt(rank)} is past every ${ds.year} closing rank here` : 'No seats in reach with these filters'}</h3>
      <p>${rank > last ? `In ${esc(ds.label)}, the last seat in this selection closed at ${K.rank} <b class="num">${fmt(last)}</b>.`
        : `In ${ds.year}, no seat in this selection closed at or near ${K.rank} ${fmt(rank)}.`}</p>${hint}
    </div>
    <div class="near"><div class="eyebrow">The seats that went furthest in ${ds.year}</div>
      <ul>${S.near.map((r, i) => `<li data-near="${i}" tabindex="0"><b>${esc(r[K.spec])}</b><span>${esc(shortCollege(r.college))} · ${esc(r.category)}</span>
        <span class="num">${K.rank} ${fmt(r[K.close])}</span></li>`).join('')}</ul></div></div>`;
}
mobile.addEventListener('change', () => { if (S.data && $('#res')) renderResults(); });

function cardHtml(r, i) {
  const kind = S.scope, K = KIND[kind], rank = parseInt(S.f[kind].rank, 10);
  const predict = S.mode === 'predict';
  return `<div class="card" data-i="${i}">
    <div class="card-top">${predict ? bandHtml(r._b) : `<span class="eyebrow">${esc(kind === 'state' ? r.programme : poolOf(kind, r))}</span>`}${starHtml(kind, r)}</div>
    <div class="card-spec">${esc(r[K.spec])}</div>
    <div class="card-coll">${esc(shortCollege(r.college))} · ${esc(r.category)}${kind === 'state' ? ' · ' + esc(seatPool(r)) : ''}</div>
    <div class="card-nums">
      <div><span>${K.rank} close</span><b>${fmt(r[K.close])}</b></div>
      <div><span>Open</span><b>${fmt(r[K.open])}</b></div>
      ${predict ? `<div><span>Margin</span><b>${r._m >= 0 ? '+' : '−'}${fmt(Math.abs(r._m))}</b></div>` : `<div><span>Seats</span><b>${r.seats ? fmt(r.seats) : '—'}</b></div>`}
    </div>
    ${predict ? `<div class="pos card-pos">${posSvg(r[K.open], r[K.close], rank, 320)}</div>` : ''}
  </div>`;
}
function drawRows(reset) {
  const tb = $('#tb');
  if (!tb) return;
  const start = reset ? 0 : tb.children.length;
  const end = Math.min(S.list.length, Math.max(S.shown, start));
  const cards = tb.classList.contains('cards');
  let h = '';
  for (let i = start; i < end; i++) {
    const r = S.list[i];
    h += cards ? cardHtml(r, i) : `<tr class="clickable" data-i="${i}">${S.cols.map(c => `<td class="${c.cls || ''}">${c.r(r)}</td>`).join('')}</tr>`;
  }
  if (reset) tb.innerHTML = h; else tb.insertAdjacentHTML('beforeend', h);
  const more = $('#more');
  more.hidden = end >= S.list.length;
  more.innerHTML = `<span>Showing ${fmt(end)} of ${fmt(S.list.length)}</span><button class="btn btn-line btn-sm" id="moreb">Show ${fmt(Math.min(STEP, S.list.length - end))} more</button>`;
  $('#moreb')?.addEventListener('click', () => { S.shown += STEP; drawRows(false); });
}
function bindRows() {
  $('#tb').onclick = async e => {
    const tr = e.target.closest('[data-i]');
    if (!tr) return;
    const r = S.list[+tr.dataset.i];
    const star = e.target.closest('[data-star]');
    if (star) {
      e.stopPropagation();
      const on = await toggleShort(S.scope, r);
      star.setAttribute('aria-pressed', String(on));
      star.innerHTML = on ? icon.starFill : icon.star;
      return;
    }
    $$('#tb .active').forEach(x => x.classList.remove('active'));
    tr.classList.add('active');
    openSeat(S.scope, r);
  };
}

// =====================================================================
// Seat detail drawer
// =====================================================================
function niceTicks(max, n = 4) {
  const raw = max / n, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * p).find(s => s >= raw);
  const out = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(v);
  return out;
}
function rangeChart(open, close, rank, unit, legend) {
  const W = 432, H = 78, L = 6, R = 6;
  const top = Math.max(close * 1.18, rank ? rank * 1.08 : 0);
  const ticks = niceTicks(top);
  const max = ticks[ticks.length - 1];
  const x = v => L + (v / max) * (W - L - R);
  const x0 = x(open), x1 = Math.max(x(close), x0 + 3);
  const mid = (x0 + x1) / 2;
  const anchor = v => v < W * 0.15 ? 'start' : v > W * 0.85 ? 'end' : 'middle';
  return `<svg class="range-chart" viewBox="0 0 ${W} ${H}" width="100%" role="img"
      aria-label="2025 range ${unit} ${open} to ${close}${rank ? `, your rank ${rank}` : ''}">
    ${ticks.map(t => `<line x1="${x(t)}" x2="${x(t)}" y1="24" y2="50" stroke="var(--rule)"/>
      <text x="${x(t)}" y="${H - 8}" text-anchor="${t === 0 ? 'start' : t === max ? 'end' : 'middle'}">${fmt(t)}</text>`).join('')}
    <line x1="${L}" x2="${W - R}" y1="50" y2="50" stroke="var(--rule-2)"/>
    <rect x="${x(close)}" y="33" width="${Math.max(0, x(close * 1.15) - x(close))}" height="10" fill="var(--b1)" opacity=".35"/>
    <rect x="${x0}" y="33" width="${x1 - x0}" height="10" fill="var(--ink-2)" opacity=".6"/>
    <text class="lbl" x="${mid}" y="${rank ? 62 : 26}" text-anchor="${anchor(mid)}">${rank ? '' : '2025 range'}</text>
    ${rank ? `<rect x="${x(rank) - 1}" y="18" width="2" height="34" fill="var(--brass)"/>
      <text class="lbl you-lbl" x="${x(rank)}" y="13" text-anchor="${anchor(x(rank))}">You · ${fmt(rank)}</text>` : ''}
  </svg>
  <div style="display:flex;gap:18px;margin-top:8px;font-size:11.5px;color:var(--muted)">
    <span style="display:inline-flex;align-items:center;gap:6px"><i style="width:10px;height:10px;background:var(--ink-2);opacity:.6"></i>${esc(legend)}</span>
    <span style="display:inline-flex;align-items:center;gap:6px"><i style="width:10px;height:10px;background:var(--b1);opacity:.35"></i>Stretch zone (+15%)</span>
    ${rank ? `<span style="display:inline-flex;align-items:center;gap:6px"><i style="width:2px;height:10px;background:var(--brass)"></i>Your rank</span>` : ''}
  </div>`;
}

let drawer = null;
function openSeat(kind, r) {
  const K = KIND[kind], f = S.f[kind];
  const rank = S.mode === 'predict' ? parseInt(f.rank, 10) || null : (parseInt(f.rank, 10) || null);
  const b = rank ? grade(rank, r, K) : null;
  const spec = r[K.spec];
  track('seat_view', { scope: kind, college: r.college, spec, category: r.category });

  const peers = S.data.rows.filter(o => o[K.spec] === spec && o.category === r.category && (kind === 'aiq' || seatPool(o) === seatPool(r)))
    .sort((a, c) => a[K.close] - c[K.close]);
  const here = S.data.rows.filter(o => o.college === r.college && o[K.spec] === spec && o !== r)
    .sort((a, c) => (a.stream || '').localeCompare(c.stream || '') || a[K.close] - c[K.close]);
  const on = !!slItem(kind, r._k);
  const margin = rank ? r[K.close] - rank : 0;
  const verdict = !rank ? '' : b
    ? `${margin >= 0 ? `${fmt(margin)} ranks inside` : `${fmt(-margin)} ranks past`} the ${S.data.dataset.year} closing rank of ${fmt(r[K.close])}.`
    : `Your ${K.rank} is more than 15% past the ${S.data.dataset.year} closing rank of ${fmt(r[K.close])}.`;
  const wa = waLink(`Hi, I'd like advice on ${spec} at ${r.college} (${kind === 'state' ? seatPool(r) + ', ' : ''}${r.category}). My ${K.rank} is ${rank || '—'}.`);

  drawer?.close();
  drawer = openDrawer(`
    <div class="dr-head">
      <div class="eyebrow">${esc(K.label)} · ${esc(S.data.dataset.year)}</div>
      <button class="icon-btn" data-close aria-label="Close">${icon.x}</button>
      <h2>${esc(spec)}</h2>
      <p>${esc(r.college)}</p>
      <div class="dr-tags">
        ${kind === 'state' ? `<span class="tag">${esc(r.programme)}</span><span class="tag">${esc(seatPool(r))}</span>` : `<span class="tag">${esc(r.type)}</span>${r.quota ? `<span class="tag">${esc(r.quota)}</span>` : ''}`}
        <span class="tag tag-solid">${esc(r.category)}</span>
      </div>
    </div>
    <div class="dr-sec">
      <h3>${rank ? 'Your position' : `${S.data.dataset.year} range`}</h3>
      ${rank ? `<div class="verdict" style="margin-bottom:18px">${b ? bandHtml(b) : '<span class="band" style="font-family:var(--serif);font-size:17px;font-weight:600">Out of range</span>'}<p>${esc(verdict)}</p></div>` : ''}
      ${rangeChart(r[K.open], r[K.close], rank, K.rank, `${S.data.dataset.year} ${closingOnly(r) ? 'last admitted' : 'opening–closing'}`)}
    </div>
    <div class="dr-sec">
      <h3>${S.data.dataset.year} record</h3>
      <dl class="facts" style="margin:0">
        <div><dt>Opening ${K.rank}</dt><dd>${closingOnly(r) ? '—<small>not published</small>' : fmt(r[K.open])}</dd></div>
        <div><dt>${closingOnly(r) ? 'Last admitted' : 'Closing'} ${K.rank}</dt><dd>${fmt(r[K.close])}</dd></div>
        <div><dt>Seats filled</dt><dd>${closingOnly(r) ? '—<small>not published</small>' : `${fmt(r.seats)} ${r.seats === 1 ? '<small>thin sample</small>' : ''}`}</dd></div>
        ${kind === 'state' ? `
          <div><dt>NEET AIR range</dt><dd>${r.air_open ? (r.air_open === r.air_close ? fmt(r.air_open) : `${fmt(r.air_open)}–${fmt(r.air_close)}`) : '—'}
            ${r.air_open && r.seats ? `<small>${r.air_seen}/${r.seats} listed</small>` : ''}</dd></div>
          <div style="grid-column:span 2"><dt>Rounds taken</dt><dd style="font-size:15px">${esc(r.rounds || '—')}</dd></div>` : `
          <div><dt>College type</dt><dd style="font-size:15px;font-family:var(--sans)">${esc(r.type)}</dd></div>
          ${r.quota ? `<div><dt>Quota</dt><dd style="font-size:15px;font-family:var(--sans)">${esc(r.quota)}</dd></div>` : ''}`}
      </dl>
    </div>
    <div class="dr-sec">
      <h3>${esc(spec)} elsewhere · ${esc(kind === 'state' ? seatPool(r) + ' · ' : '')}${esc(r.category)}</h3>
      <table class="mini">${peers.slice(0, 12).map(o => `
        <tr class="${o === r ? 'here' : ''}"><td>${rank ? `<span class="band b${grade(rank, o, K)}"><i style="${grade(rank, o, K) ? '' : 'background:var(--rule-2)'}"></i></span> ` : ''}
          ${o === r ? esc(shortCollege(o.college)) : `<a href="#" data-peer="${S.data.rows.indexOf(o)}">${esc(shortCollege(o.college))}</a>`}</td>
          <td class="n">${fmt(o[K.close])}</td></tr>`).join('')}
      </table>
      ${peers.length > 12 ? `<p class="muted" style="font-size:12px;margin:10px 0 0">${peers.length - 12} more in the cut-off table.</p>` : ''}
    </div>
    ${here.length ? `<div class="dr-sec">
      <h3>Other ${kind === 'state' ? 'streams and categories' : 'categories'} at this college</h3>
      <table class="mini">${here.map(o => `<tr><td><a href="#" data-peer="${S.data.rows.indexOf(o)}">${esc(kind === 'state' ? seatPool(o) + ' · ' : '')}${esc(o.category)}</a></td>
        <td class="n">${fmt(o[K.open])}–${fmt(o[K.close])}</td></tr>`).join('')}</table>
    </div>` : ''}
    <div class="dr-actions">
      <button class="btn ${on ? 'btn-line' : 'btn-primary'}" id="dr-star">${on ? icon.starFill + ' In your shortlist' : icon.star + ' Add to shortlist'}</button>
      ${wa ? `<a class="btn btn-line" href="${esc(wa)}" target="_blank" rel="noopener" id="dr-wa">${icon.chat} Ask a counsellor</a>` : ''}
    </div>`, { onClose: () => { $$('#tb .active').forEach(x => x.classList.remove('active')); drawer = null; } });

  drawer.el.addEventListener('click', e => {
    const a = e.target.closest('[data-peer]');
    if (!a) return;
    e.preventDefault();
    openSeat(kind, S.data.rows[+a.dataset.peer]);
  });
  $('#dr-star', drawer.el).onclick = async () => {
    await toggleShort(kind, r);
    const tr = S.list.indexOf(r);
    const star = $(`#tb [data-i="${tr}"] [data-star]`);
    if (star) { const now = !!slItem(kind, r._k); star.setAttribute('aria-pressed', String(now)); star.innerHTML = now ? icon.starFill : icon.star; }
    openSeat(kind, r);
  };
  $('#dr-wa', drawer.el)?.addEventListener('click', () => track('contact_click', { from: 'seat', college: r.college, spec }));
}

// =====================================================================
// Shortlist page
// =====================================================================
async function viewShortlist() {
  await loadShortlist();
  const items = S.shortlist;
  view.innerHTML = workTabs('/shortlist') + `
    <div class="page-head">
      <div><div class="eyebrow">Your preference list</div><h1>Shortlist</h1>
        <p>Arrange seats in the order you would fill your choice form. Chances are graded against the rank you last entered in the predictor.</p></div>
      <div class="res-actions">
        <button class="btn btn-line btn-sm" id="sl-csv" ${items.length ? '' : 'disabled'}>${icon.download} Export CSV</button>
        <button class="btn btn-line btn-sm" id="sl-print" ${items.length ? '' : 'disabled'}>${icon.print} Print</button>
      </div>
    </div>
    ${items.length ? ['state', 'aiq'].map(kind => slGroup(kind, items.filter(i => i.kind === kind))).join('') : `
      <div class="sl-group"><div class="grid-wrap"><div class="empty"><h3>Nothing shortlisted yet</h3>
        <p>Use the ${icon.star.replace('<svg', '<svg style="width:14px;height:14px;vertical-align:-2px"')} on any seat in the predictor or the cut-off table to save it here.</p>
        <a class="btn btn-primary" href="/predict" data-link style="margin-top:12px">Open the predictor</a></div></div></div>`}`;

  updateCount();
  $('#sl-print').onclick = () => print();
  $('#sl-csv').onclick = () => {
    const rows = [];
    for (const kind of ['state', 'aiq']) {
      const K = KIND[kind], rank = parseInt(S.f[kind].rank, 10);
      items.filter(i => i.kind === kind).forEach((i, n) => {
        const r = i.row;
        rows.push([n + 1, K.label, r.college, r[K.spec], poolOf(kind, r), r.category, r[K.open], r[K.close], rank ? (BAND[grade(rank, r, K)] || 'Out of range') : '', i.dataset]);
      });
    }
    downloadCsv('rankround-shortlist.csv', ['Preference', 'Counselling', 'College', 'Speciality / branch', 'Quota or stream / type', 'Category', 'Opening rank', 'Closing rank', 'Chance', 'Data'], rows);
    track('export', { mode: 'shortlist', rows: rows.length });
  };
  view.onclick = async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = +b.dataset.id, act = b.dataset.act;
    b.disabled = true;
    try {
      if (act === 'rm') {
        S.shortlist = (await api('/api/shortlist/' + id, { method: 'DELETE' })).items;
        toast('Removed from shortlist.');
      } else {
        const it = S.shortlist.find(i => i.id === id);
        const same = S.shortlist.filter(i => i.kind === it.kind);
        const k = same.indexOf(it), j = act === 'up' ? k - 1 : k + 1;
        if (j < 0 || j >= same.length) return;
        [same[k], same[j]] = [same[j], same[k]];
        const order = ['state', 'aiq'].flatMap(kd => kd === it.kind ? same : S.shortlist.filter(i => i.kind === kd));
        S.shortlist = (await api('/api/shortlist/order', { method: 'PUT', body: { ids: order.map(i => i.id) } })).items;
      }
    } catch (err) { b.disabled = false; toast(err.message, true); return; }
    updateCount();
    view.onclick = null;
    viewShortlist();
  };
}
function slGroup(kind, items) {
  if (!items.length) return '';
  const K = KIND[kind], rank = parseInt(S.f[kind].rank, 10);
  return `<section class="sl-group">
    <h2>${K.label} <span>${items.length} seat${items.length === 1 ? '' : 's'} · ranked by ${K.rank}${rank ? ` · graded at ${K.rank} ${fmt(rank)}` : ''}</span></h2>
    <div class="grid-wrap"><table class="grid">
      <thead><tr><th>#</th><th>College</th><th>${K.specLabel}</th><th>${kind === 'state' ? 'Stream' : 'Type'}</th><th>Category</th>
        <th class="r">${K.rank} open</th><th class="r">${K.rank} close</th><th>Chance</th><th class="no-print"><span class="sr">Actions</span></th></tr></thead>
      <tbody>${items.map((i, n) => {
        const r = i.row, b = rank ? grade(rank, r, K) : null;
        return `<tr>
          <td class="ord">${String(n + 1).padStart(2, '0')}</td>
          <td class="strong wrapcell">${esc(shortCollege(r.college))}<span class="sub">${esc(i.dataset)}</span></td>
          <td class="wrapcell">${esc(r[K.spec])}${kind === 'state' ? `<span class="sub">${esc(r.programme)}</span>` : ''}</td>
          <td class="nowrap">${esc(poolOf(kind, r))}</td><td class="nowrap">${esc(r.category)}</td>
          <td class="n soft">${fmt(r[K.open])}</td><td class="n">${fmt(r[K.close])}</td>
          <td class="nowrap">${rank ? (b ? bandHtml(b) : '<span class="muted">Out of range</span>') : '<span class="muted">—</span>'}</td>
          <td class="no-print"><div class="reorder">
            <button class="icon-btn" data-act="up" data-id="${i.id}" aria-label="Move up" ${n ? '' : 'disabled'}>${icon.up}</button>
            <button class="icon-btn" data-act="down" data-id="${i.id}" aria-label="Move down" ${n < items.length - 1 ? '' : 'disabled'}>${icon.down}</button>
            <button class="icon-btn" data-act="rm" data-id="${i.id}" aria-label="Remove">${icon.trash}</button>
          </div></td></tr>`;
      }).join('')}</tbody>
    </table></div></section>`;
}

// =====================================================================
// Counselling guides: /counselling lists the guides with their live dates. The guide
// pages themselves are separate documents at /counselling/<slug> (server/guides.js).
// =====================================================================
const ALL_INDIA = 'All India';
const guidesFor = region => (S.cfg.guides || []).filter(g => g.region === region);
function guideBanner() {
  const states = [...new Set((S.cfg.guides || []).filter(g => g.region !== ALL_INDIA).map(g => g.region))].sort();
  return states.length
    ? `Live dates and plain-language guides for the All India Quota and ${states.length} states, from ${states[0]} to ${states[states.length - 1]}.`
    : 'Live dates and plain-language guides for the All India Quota.';
}

const istDay = ms => Math.floor((ms + 19800e3) / 86400e3); // calendar day in India
const istClock = ms => new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const istWhen = ms => new Date(ms).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
function timeLeft(ms) {
  const h = Math.floor(ms / 36e5), m = Math.floor(ms % 36e5 / 6e4);
  return h >= 48 ? `${Math.floor(h / 24)} days left` : h >= 1 ? `${h}h ${m}m left` : `${Math.max(m, 1)} min left`;
}
/** Where one dated step stands now. tone: open | urgent | soon | done | info | wait. */
function stepStatus(d, now = Date.now()) {
  if (d.label) return { tone: d.label === 'Awaited' ? 'wait' : 'info', text: d.label };
  if (d.on) {
    const days = istDay(Date.parse(d.on)) - istDay(now);
    if (days < 0) return { tone: 'done', text: 'Done' };
    return days === 0 ? { tone: 'open', text: 'Today' } : { tone: 'soon', text: days === 1 ? 'Tomorrow' : `In ${days} days` };
  }
  const end = Date.parse(d.to), start = d.from ? Date.parse(d.from) : -Infinity;
  if (now > end) return { tone: 'done', text: 'Closed' };
  if (now < start) {
    const days = istDay(start) - istDay(now);
    return { tone: 'soon', text: days === 0 ? `Opens ${istClock(start)}` : days === 1 ? 'Opens tomorrow' : `Opens in ${days} days` };
  }
  return end - now < 48 * 36e5 ? { tone: 'urgent', text: timeLeft(end - now) } : { tone: 'open', text: `Open · ${timeLeft(end - now)}` };
}
const stepPill = i => { const st = stepStatus(S.gdSteps[i]); return `<span class="gd-pill ${st.tone}" data-step="${i}">${esc(st.text)}</span>`; };

/** One card per state (holding all its guides); each All India guide gets its own card. */
function guideCards(guides) {
  const cards = [];
  for (const g of guides) {
    const key = g.region === ALL_INDIA ? g.slug : g.region;
    let c = cards.find(x => x.key === key);
    if (!c) cards.push(c = { key, region: g.region, title: g.region === ALL_INDIA ? g.title : g.region, authority: g.authority, guides: [], steps: [] });
    c.guides.push(g);
    c.steps.push(...(g.dates || []).map(d => ({ ...d, card: c.title, slug: g.slug })));
  }
  return cards;
}

async function viewGuides() {
  // Links to the old one-page hub (/counselling#kerala) open the matching guide.
  const old = { mcc: 'mcc', gujarat: 'gujarat', karnataka: 'karnataka', kerala: 'kerala-prospectus' }[location.hash.slice(1)];
  if (old) { location.replace('/counselling/' + old); return; }
  if (!S.guideIndex) view.innerHTML = '<div class="gd"><div class="empty"><span class="spinner"></span></div></div>';
  try { S.guideIndex ||= await api('/api/guides'); }
  catch (e) { view.innerHTML = `<div class="gd"><div class="empty"><h3>Couldn't load the guides</h3><p>${esc(e.message)}</p></div></div>`; return; }
  if (S.path !== '/counselling') return;
  const { guides, compare, documents = [], updates = [] } = S.guideIndex;
  const cards = guideCards(guides);
  // States with official documents but no guide yet still get a card for them.
  for (const r of new Set(documents.map(d => d.region)))
    if (r !== ALL_INDIA && !cards.some(c => c.region === r)) cards.push({ key: r, region: r, title: r, authority: 'Official documents', guides: [], steps: [] });
  S.gdSteps = cards.flatMap(c => c.steps);
  const mine = S.user?.state || '';
  const states = cards.filter(c => c.region !== ALL_INDIA)
    .sort((a, b) => (b.region === mine) - (a.region === mine) || a.title.localeCompare(b.title));
  const docsOf = c => c.region === ALL_INDIA ? [] : documents.filter(d => d.region === c.region);
  const docLink = d => `<a href="/counselling/assets/${esc(d.file)}" target="_blank" rel="noopener"><span class="gd-doc-kind">${esc(d.kind)}</span>
    <b>${esc(d.title)}</b><small>${esc(shortDate(d.date))} · PDF · ${d.kb >= 1024 ? (d.kb / 1024).toFixed(1) + ' MB' : d.kb + ' KB'}</small></a>`;
  const card = c => `
    <article class="gd-card${c.region === mine ? ' mine' : ''}"${c.region === ALL_INDIA ? '' : ` id="${docsAnchor(c.region)}"`}
      data-q="${esc([c.title, c.authority, ...c.guides.flatMap(g => [g.title, g.label]), ...docsOf(c).map(d => d.title)].join(' ').toLowerCase())}">
      <div class="gd-card-head">
        ${c.region === mine ? '<span class="gd-mine">Your state</span>' : ''}
        <h3>${esc(c.title)}</h3>
        <p>${esc(c.authority)}</p>
      </div>
      ${c.steps.length ? `<ul class="gd-steps">${c.steps.map(d => `<li>
        <span class="gd-what">${esc(d.what)}<small>${esc(d.when)}</small></span>${stepPill(S.gdSteps.indexOf(d))}</li>`).join('')}</ul>` : ''}
      ${docsOf(c).length ? `<details class="gd-docs"${c.guides.length ? '' : ' open'}><summary>Official documents <span>${docsOf(c).length}</span></summary>
        <ul>${docsOf(c).map(d => `<li>${docLink(d)}</li>`).join('')}</ul></details>` : ''}
      <div class="gd-links">${c.region === ALL_INDIA ? '' : `<a class="gd-link gd-rm" href="/roadmap/${esc(slugOf(c.region))}" data-link>
        <span><b>Counselling roadmap</b><small>Stage, dates, ${c.guides.length ? 'the guide, ' : ''}merit list and seat matrix in one place</small></span>${icon.arrowR}</a>`}${c.guides.map(g => `<a class="gd-link" href="/counselling/${esc(g.slug)}">
        <span><b>${esc(c.guides.length > 1 ? g.label : 'Open the guide')}</b><small>${esc(g.summary)}</small></span>${icon.arrowR}</a>`).join('')}</div>
    </article>`;
  // The latest counselling news, newest first; the student's own state stands out.
  const news = [...updates].sort((a, b) => b.date.localeCompare(a.date));
  const newsLink = u => u.doc ? `<a href="/counselling/assets/${esc(u.doc)}" target="_blank" rel="noopener">Notice (PDF)</a>`
    : u.link ? `<a href="${esc(u.link)}"${appRoute(u.link) ? ' data-link' : ''}>Open</a>`
    : guidesFor(u.region)[0] ? `<a href="/counselling/${esc(guidesFor(u.region)[0].slug)}">Guide</a>` : '';
  const SHOW = 6;
  view.innerHTML = `<div class="gd">
    <div class="gd-head">
      <div class="eyebrow">NEET-PG 2026 · Counselling guides</div>
      <h1>Every counselling, in plain language.</h1>
      <p class="gd-lede">Dates, eligibility, documents, fees and bonds for the All India Quota and each state's counselling, summarised
        from the official notices. Always confirm on the official website before acting.</p>
      <label class="gd-search">${icon.search}<input class="input" type="search" id="gd-q" placeholder="Find your state or a guide"
        autocomplete="off" aria-label="Find your state or a guide"></label>
      ${mine ? `<p class="gd-yours"><span class="eyebrow">Your state · ${esc(mine)}</span><a href="/roadmap/${esc(slugOf(mine))}" data-link>${esc(mine)} roadmap ${icon.arrowR}</a>${guidesFor(mine)
        .map(g => `<a href="/counselling/${esc(g.slug)}">${esc(g.label)} ${icon.arrowR}</a>`).join('')}</p>` : ''}
    </div>
    ${news.length ? `<section class="gd-updates" aria-labelledby="gd-up-h">
      <div class="gd-updates-head"><h2 class="eyebrow" id="gd-up-h">Latest updates</h2><span>From the official notices · ${esc(shortDate(news[0].date))}</span></div>
      <ol>${news.map((u, i) => `<li class="${u.region === mine ? 'mine' : ''}"${i >= SHOW ? ' hidden' : ''}>
        <time datetime="${esc(u.date)}">${esc(shortDate(u.date))}</time><b>${esc(u.region)}</b><span>${esc(u.text)}</span>${newsLink(u)}</li>`).join('')}</ol>
      ${news.length > SHOW ? `<button type="button" class="linkbtn" id="gd-more">Show all ${news.length} updates</button>` : ''}
    </section>` : ''}
    <div id="gd-soon"></div>
    <section class="gd-sec" data-sec>
      <div class="gd-sec-head"><h2>All India</h2>
        <p>MCC counsels the All India Quota, deemed universities, central institutes and DNB seats.
          <a href="/roadmap/all-india" data-link>All India roadmap: stage, dates and the Round 1 result ${icon.arrowR}</a></p></div>
      <div class="gd-grid">${cards.filter(c => c.region === ALL_INDIA).map(card).join('')}</div>
    </section>
    <section class="gd-sec" data-sec>
      <div class="gd-sec-head"><h2>State quota</h2>
        <p>Each state counsels its own quota. ${states.length} states so far, with more added as their notices come out.${mine && !states.some(c => c.region === mine)
          ? ` There's no ${esc(mine)} guide yet.` : ''}</p></div>
      <div class="gd-grid">${states.map(card).join('')}</div>
    </section>
    <p class="gd-none" id="gd-none" hidden></p>
    ${compare ? `<details class="gd-compare"><summary>${esc(compare.title)}</summary>
      <div class="grid-wrap"><table class="grid">
        <thead><tr><th>Point</th>${compare.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${compare.rows.map(r => `<tr><td class="strong">${esc(r.label)}</td>${r.cells.map(c => `<td>${c.href
          ? `<a href="${esc(c.href)}" target="_blank" rel="noopener">${esc(c.text)}</a>`
          : c.gap ? `<span class="gd-gap">${esc(c.text)}</span>` : esc(c.text)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
      ${compare.note ? `<p class="gd-note">${esc(compare.note)}</p>` : ''}</details>` : ''}
  </div>`;
  renderSoon();
  if ($('#gd-more')) $('#gd-more').onclick = e => { $$('.gd-updates li[hidden]').forEach(li => { li.hidden = false; }); e.target.remove(); };
  // From a guide's "Official documents" link: open that state's list.
  const docs = location.hash.startsWith('#docs-') && document.getElementById(location.hash.slice(1));
  if (docs) { const d = $('.gd-docs', docs); if (d) d.open = true; requestAnimationFrame(() => docs.scrollIntoView({ block: 'start' })); }
  $('#gd-q').oninput = e => {
    const raw = e.target.value.trim(), terms = raw.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    $$('.gd-card').forEach(c => { c.hidden = !terms.every(t => c.dataset.q.includes(t)); shown += !c.hidden; });
    $$('[data-sec]').forEach(sec => { sec.hidden = !sec.querySelector('.gd-card:not([hidden])'); });
    const none = $('#gd-none');
    none.hidden = shown > 0;
    none.textContent = shown ? '' : `No guide matches “${raw}” yet. We add states as their notices come out.`;
  };
  // Keep the pills current while the page stays open.
  clearInterval(S.gdTimer);
  S.gdTimer = setInterval(() => {
    if (S.path !== '/counselling' || !$('#gd-soon')) return clearInterval(S.gdTimer);
    $$('[data-step]').forEach(el => { const st = stepStatus(S.gdSteps[+el.dataset.step]); el.className = `gd-pill ${st.tone}`; el.textContent = st.text; });
    renderSoon();
  }, 30e3);
}

const appRoute = href => !/^\/counselling\/./.test(href);
const shortDate = iso => new Date(`${iso.slice(0, 10)}T00:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
// Must match docsAnchor() in server/guides.js.
const docsAnchor = region => 'docs-' + region.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/** The "closing in the next 3 days" strip on /counselling. */
function renderSoon() {
  const now = Date.now();
  const soon = S.gdSteps.filter(d => d.to && !d.label && (!d.from || Date.parse(d.from) <= now)
    && Date.parse(d.to) > now && Date.parse(d.to) - now < 72 * 36e5).sort((a, b) => Date.parse(a.to) - Date.parse(b.to));
  $('#gd-soon').innerHTML = soon.length ? `<section class="gd-soon" aria-label="Closing soon">
    <div class="eyebrow">Closing in the next 3 days</div>
    <ul>${soon.map(d => `<li><a href="/counselling/${esc(d.slug)}"><b>${esc(d.card)}</b>
      <span>${esc(d.what)} · closes ${esc(istWhen(Date.parse(d.to)))}</span></a>${stepPill(S.gdSteps.indexOf(d))}</li>`).join('')}</ul>
  </section>` : '';
}

// =====================================================================
// Counselling roadmap: one page per region, in the same layout for All India and every state
// (/roadmap/<region>/<stage>/<view>). Stages, dates and guides are for everyone; merit lists, seat
// matrices and allotments need an account: All India data for every candidate, a state's data for
// candidates registered for that state.
// =====================================================================
const STAGES = ['Registration', 'Merit List', 'Round 1', 'Round 2', 'Round 3', 'Stray Vacancy'];
const slugOf = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const ROUND_VIEWS = [
  ['choice-filling', 'Choice filling', 'Seat matrix, enter and lock your choices', 'doc'],
  ['allotment', 'Allotment', 'Seats allotted in this round', 'check'],
  ['joined', 'Joined', 'Joining status after allotment', 'users']
];
const RP_ICON = {
  doc: '<path d="M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5"/>',
  calendar: '<path d="M4 5h16v15H4zM4 10h16M9 3v4M15 3v4"/>',
  cap: '<path d="M2 9l10-5 10 5-10 5zM6 11v5c3 2 9 2 12 0v-5"/>',
  seat: '<path d="M8 4h8v7H8zM6 11h12v3H6zM8 14l-1 6M16 14l1 6"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20c.5-3.5 3-5.5 6-5.5s5.5 2 6 5.5M16 5.5a3 3 0 0 1 0 5.5M18 14.8c1.8.8 2.8 2.6 3 5.2"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h1M4 12h1M4 18h1"/>',
  swap: '<path d="M7 20V5M3 9l4-4 4 4M17 4v15M13 15l4 4 4-4"/>',
  alert: '<path d="M12 3l9.5 17h-19zM12 10v4M12 17v.5"/>',
  rupee: '<path d="M7 5h11M7 9.5h11M7 5h4a4.5 4.5 0 0 1 0 9H8l8 6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  folder: '<path d="M3 6h7l2 2h9v11H3z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
  grid: '<path d="M4 4h16v16H4zM4 12h16M12 4v16"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>'
};
const rpSvg = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${RP_ICON[k]}</svg>`;
// An icon and a colour for each kind of guide section, read from its heading. First match wins.
const SECTION_LOOK = [
  [/mop-up|stray|upgrad|seat order|getting out|exit/i, 'swap', 'orange'],
  [/certificate|form|photo|signature/i, 'doc', 'blue'],
  [/date|schedule|timeline/i, 'calendar', 'blue'],
  [/eligib|who can|apply|qualif|local/i, 'cap', 'blue'],
  [/bonus|in-service|service quota|weightage/i, 'users', 'green'],
  [/seat|reservation|quota|matrix|college|subject/i, 'seat', 'green'],
  [/round|counselling works|process|steps|allotment|choice|how /i, 'list', 'purple'],
  [/rule|penalt|bond|strict|forfeit|life/i, 'alert', 'red'],
  [/fee|deposit|cost|stipend|refund|money/i, 'rupee', 'orange'],
  [/watch|mistake|tip|caution|gap|issue|error|unclear|points|bottom line|read before/i, 'eye', 'orange'],
  [/document|checklist|upload|ready/i, 'folder', 'purple'],
  [/contact|help/i, 'phone', 'blue']
];
const sectionLook = t => (SECTION_LOOK.find(([re]) => re.test(t)) || [null, 'info', 'blue']).slice(1);
const secTitle = s => /^at a glance$/i.test(s.title) ? 'Summary' : s.title; // the overview chip is already "At a glance"
const rpStatus = (info, stage) => {
  const cur = STAGES.indexOf(info.progress?.stage), i = STAGES.indexOf(stage);
  return cur < 0 ? '' : i < cur ? 'done' : i === cur ? 'current' : 'upcoming';
};
const RP_PILL = { done: ['open', 'Completed'], current: ['info', 'Current stage'], upcoming: ['wait', 'Upcoming'] };
const rpPill = st => st ? `<span class="gd-pill ${RP_PILL[st][0]}">${RP_PILL[st][1]}</span>` : '';

async function regionInfo(key) {
  const ck = `${key}|${S.user?.state || ''}`; // what a candidate may open depends on their state
  S.rpInfo ||= {};
  return S.rpInfo[ck] ||= await api('/api/regions/' + encodeURIComponent(key));
}

async function viewRoadmap() {
  const key = location.pathname.split('/').filter(Boolean)[1];
  if (!key) { // the student's own state, or All India
    history.replaceState({}, '', `/roadmap/${slugOf(S.user?.state || ALL_INDIA)}`);
    return viewRoadmap();
  }
  if (!S.rpInfo?.[`${key}|${S.user?.state || ''}`]) view.innerHTML = '<div class="rp-wait"><span class="spinner"></span></div>';
  let info;
  try {
    [info] = await Promise.all([regionInfo(key), key === 'all-india' && !S.guideIndex ? api('/api/guides').then(g => { S.guideIndex = g; }).catch(() => {}) : null]);
  } catch (e) {
    view.innerHTML = `<div class="gd"><div class="empty"><h3>${e.status === 404 ? 'There is no such state' : "We couldn't load this page"}</h3><p>${esc(e.message)}</p>
      <div class="empty-actions"><a class="btn btn-line" href="/roadmap/all-india" data-link>All India roadmap</a></div></div></div>`;
    return;
  }
  if (S.path !== '/roadmap' || location.pathname.split('/')[2] !== key) return;
  const regions = [ALL_INDIA, ...S.cfg.states];
  view.innerHTML = `<div class="rp">
    <div class="rp-main">
      <nav class="rp-crumb" aria-label="Breadcrumb"><a href="/counselling" data-link>Counselling 2026</a><span aria-hidden="true">›</span><span>Roadmap</span>
        <span aria-hidden="true">›</span><select class="select" id="rp-region" aria-label="State">${regions.map(r =>
          `<option value="${slugOf(r)}"${r === info.region ? ' selected' : ''}>${esc(r)}${r === S.user?.state ? ' · your state' : ''}</option>`).join('')}</select></nav>
      <h1>NEET-PG 2026 Counselling Roadmap</h1>
      <p class="rp-lede"><b>${esc(info.region === ALL_INDIA ? 'All India Quota (MCC)' : `${info.region} state quota`)}.</b>
        Track the counselling progress and get predictions as data becomes available.</p>
      ${info.progress ? `<p class="rp-now">${esc(info.progress.note || '')}${info.progress.asOf ? ` <small>As of ${esc(shortDate(info.progress.asOf))}</small>` : ''}</p>`
        : `<p class="rp-now">We don't track ${esc(info.region)}'s stage yet: the dates and official documents here are the latest we have.</p>`}
      ${info.review ? `<p class="rp-review">${icon.lock}<span><b>Review access.</b> ${info.review === 'admin'
        ? "You are signed in to the admin console, so every state's data is open in this browser."
        : "This account opens every state's data."} Candidates see only their own state's data.</span></p>` : ''}
      <nav aria-label="Stages"><ol class="rp-steps" id="rp-steps"></ol></nav>
      <section class="rp-panel" id="rp-panel"></section>
    </div>
    <aside class="rp-side" aria-label="Important dates">${rpDates(info)}</aside>
  </div>`;
  $('#rp-region').onchange = e => go('/roadmap/' + e.target.value);
  $('.rp').addEventListener('click', e => {
    const a = e.target.closest('a[data-rp]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    history.pushState({}, '', a.pathname);
    rpPanel(info);
    const p = $('#rp-panel');
    if (p.getBoundingClientRect().top < 0) p.scrollIntoView({ block: 'start' });
  });
  const more = $('#rp-alldates');
  if (more) more.onclick = () => { $$('.rp-dates li[hidden]').forEach(li => { li.hidden = false; }); more.remove(); };
  rpPanel(info);
}

function rpPanel(info) {
  const parts = location.pathname.split('/').filter(Boolean).slice(2);
  const stage = STAGES.find(s => slugOf(s) === parts[0]) || info.progress?.stage || 'Registration';
  // the stepper is the stage menu: each step opens its stage, the one shown is marked
  $('#rp-steps').innerHTML = STAGES.map((s, i) => { const st = rpStatus(info, s); return `<li class="${st}${s === stage ? ' on' : ''}">
    <a href="/roadmap/${info.key}/${slugOf(s)}" data-rp${s === stage ? ' aria-current="page"' : ''}><span class="rp-dot">${st === 'done' ? '✓' : i + 1}</span><b>${s}</b>${rpPill(st)}</a></li>`; }).join('');
  const box = $('#rp-panel');
  if (stage === 'Registration') rpRegistration(info, box, parts.slice(1));
  else if (stage === 'Merit List') rpMerit(info, box);
  else rpRound(info, box, stage, parts.slice(1));
}

// "31 Oct", "Dated 14 Oct 2026": the day a label-only date names (this counselling year), or Infinity.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function dayIn(text) {
  const m = /(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(\d{4}))?/i.exec(text || '');
  if (!m) return Infinity;
  const mon = MONTHS.indexOf(m[2].toLowerCase()), now = new Date();
  const year = +m[3] || now.getFullYear() + (mon < now.getMonth() - 6 ? 1 : 0); // Jan–Mar belong to the next calendar year
  return Date.parse(`${year}-${String(mon + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}T12:00:00+05:30`);
}
// The region's dates, in date order. Closed ones fold away (all but the last two).
function rpDates(info) {
  const items = [...info.dates];
  if (info.region === ALL_INDIA) for (const s of S.guideIndex?.roadmap?.stages || [])
    items.push({ what: s.name, when: stageSpan({ a: Date.parse(s.from), b: Date.parse(s.to) }), from: s.from, to: s.to });
  const at = d => Date.parse(d.on || d.from || d.to || '') || dayIn(d.when);
  const list = items.map(d => ({ d, t: at(d), s: stepStatus(d) })).sort((a, b) => a.t - b.t);
  const done = list.filter(x => x.s.tone === 'done').length;
  const hide = x => x.s.tone === 'done' && list.indexOf(x) < done - 2;
  const day = t => new Date(t).toLocaleDateString('en-IN', { day: '2-digit', timeZone: 'Asia/Kolkata' });
  const mon = t => new Date(t).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  return `<h2>${rpSvg('calendar')} Important dates <small>Upcoming events</small></h2>
    ${list.length ? `<ol class="rp-dates">${list.map(x => `<li class="${x.s.tone}"${hide(x) ? ' hidden' : ''}>
      <span class="rp-day">${Number.isFinite(x.t) ? `<b>${day(x.t)}</b><small>${mon(x.t)}</small>` : '<b>·</b>'}</span>
      <span class="rp-what"><b>${esc(x.d.what)}</b><small>${esc(x.d.when)}</small><span class="gd-pill ${x.s.tone}">${esc(x.s.text)}</span></span></li>`).join('')}</ol>
      ${list.some(hide) ? `<button type="button" class="btn btn-line rp-more" id="rp-alldates">${rpSvg('calendar')} View all dates (${list.length})</button>` : ''}`
      : `<p class="rp-nodates">No dates for ${esc(info.region)} yet. They appear here as its notices come out.</p>`}`;
}

const rpHead = (info, stage, ic, text, action = '') => `
  <div class="rp-head"><span class="rp-hicon">${rpSvg(ic)}</span>
    <div><h2>${esc(stage)} ${rpPill(rpStatus(info, stage))}</h2><p>${text}</p></div>
    ${action ? `<div class="rp-head-act">${action}</div>` : ''}</div>`;
const rpSoon = (ic, title, text) => `<div class="rp-soon">${rpSvg(ic)}<h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;
const rpDocList = (docs, title, open = false) => docs.length ? `<details class="rp-docs"${open ? ' open' : ''}><summary>${esc(title)} <span>${docs.length}</span></summary>
  <ul>${docs.map(d => `<li><a href="/counselling/assets/${esc(d.file)}" target="_blank" rel="noopener"><span class="gd-doc-kind">${esc(d.kind)}</span>
    <b>${esc(d.title)}</b><small>${esc(shortDate(d.date))} · PDF · ${d.kb >= 1024 ? (d.kb / 1024).toFixed(1) + ' MB' : d.kb + ' KB'}</small></a></li>`).join('')}</ul></details>` : '';

// ---- Registration: the region's guides, section by section, in one common layout ----
async function rpRegistration(info, box, rest) {
  const guides = info.guides.filter(g => g.sections.length), tools = info.guides.filter(g => !g.sections.length);
  const g = guides.find(x => x.slug === rest[0]) || guides[0];
  const secId = g && rest[0] === g.slug ? rest[1] : null;
  const official = (g || info.guides[0])?.official;
  const href = (...p) => `/roadmap/${info.key}/registration/${p.join('/')}`;
  box.innerHTML = rpHead(info, 'Registration', 'doc', 'Complete online registration, fill choices and upload the documents the official notification asks for.',
    official ? `<a class="btn btn-primary" href="${esc(official)}" target="_blank" rel="noopener">Go to official website ${icon.ext}</a>` : '')
    + (g ? `${guides.length > 1 ? `<div class="rp-guides" role="group" aria-label="Guide">${guides.map(x =>
        `<a href="${href(x.slug)}" data-rp${x === g ? ' aria-current="true"' : ''}>${esc(x.label)}</a>`).join('')}</div>` : ''}
      <nav class="rp-chips" aria-label="Sections"><a href="${href(g.slug)}" data-rp${secId ? '' : ' aria-current="true"'}>At a glance</a>${g.sections.map(s =>
        `<a href="${href(g.slug, s.id)}" data-rp${s.id === secId ? ' aria-current="true"' : ''}>${esc(secTitle(s))}</a>`).join('')}</nav>
      <div id="rp-read"></div>`
      : rpSoon('doc', `No ${info.region} guide yet`, "We write a plain-language guide once the state's prospectus is out. Meanwhile, its official documents are below."))
    + (tools.length ? `<div class="rp-tools">${tools.map(t => `<a class="rp-tool" href="/counselling/${esc(t.slug)}">${rpSvg('grid')}
        <span><b>${esc(t.label)}</b><small>${esc(t.summary || '')}</small></span>${icon.arrowR}</a>`).join('')}</div>` : '')
    + rpDocList(info.documents, 'Official documents', !g);
  if (!g) return;
  const read = $('#rp-read');
  const idx = secId ? g.sections.findIndex(s => s.id === secId) : -1;
  if (idx < 0) {
    read.innerHTML = `<div class="rp-glance-head">${rpSvg('doc')}<div><h3>At a glance</h3><p>${esc(g.summary || g.title)}</p></div></div>
      <div class="rp-glance">${g.sections.map(s => { const [ic, tone] = sectionLook(s.title); return `<a class="rp-gcard t-${tone}" href="${href(g.slug, s.id)}" data-rp>
        <span class="rp-gicon">${rpSvg(ic)}</span><span class="rp-gtext"><b>${esc(secTitle(s))}</b><small>${esc(s.blurb)}</small></span>${rpSvg('chevron')}</a>`; }).join('')}</div>
      <p class="rp-orig"><a href="/counselling/${esc(g.slug)}?original">Open the full guide in its original layout ${icon.ext}</a></p>`;
    return;
  }
  const s = g.sections[idx], [ic, tone] = sectionLook(s.title), prev = g.sections[idx - 1], next = g.sections[idx + 1];
  read.innerHTML = '<div class="rp-wait"><span class="spinner"></span></div>';
  S.rpSec ||= {};
  let sec;
  try { sec = S.rpSec[g.slug + '/' + s.id] ||= await api(`/api/sections/${g.slug}/${s.id}`); }
  catch (e) { read.innerHTML = `<div class="empty"><h3>We couldn't load this section</h3><p>${esc(e.message)}</p></div>`; return; }
  if (!read.isConnected) return;
  read.innerHTML = `<article class="rp-read">
    <div class="rp-read-head"><span class="rp-gicon t-${tone}">${rpSvg(ic)}</span><div><h3>${esc(secTitle(sec))}</h3><small>${esc(g.title)}</small></div></div>
    <div class="rp-prose">${sec.html}</div>
    <div class="rp-read-nav">${prev ? `<a href="${href(g.slug, prev.id)}" data-rp><small>Previous</small><b>${esc(secTitle(prev))}</b></a>` : `<a href="${href(g.slug)}" data-rp><small>Back to</small><b>At a glance</b></a>`}
      ${next ? `<a class="next" href="${href(g.slug, next.id)}" data-rp><small>Next</small><b>${esc(secTitle(next))}</b></a>` : ''}</div>
    <p class="rp-orig">Summarised from the official notice: confirm on the official website before acting. <a href="/counselling/${esc(g.slug)}?original">Original layout ${icon.ext}</a></p>
  </article>`;
}

// ---- Merit list ----
function rpMerit(info, box) {
  const d = info.data.find(x => x.kind === 'merit');
  const docs = info.documents.filter(x => x.kind === 'Merit list');
  const pdf = d?.doc || docs[0]?.file;
  box.innerHTML = rpHead(info, 'Merit List', 'list', info.region === ALL_INDIA
    ? 'For the All India Quota, the merit list is the NEET-PG 2026 result: the MCC allots seats in order of All India Rank.'
    : `View the ${esc(info.region)} state merit list for NEET-PG 2026, as per the official release.`,
    pdf ? `<a class="btn btn-line" href="/counselling/assets/${esc(pdf)}" target="_blank" rel="noopener">${icon.download} Download (PDF)</a>` : '')
    + '<div id="rp-data"></div>' + rpDocList(docs, 'Official merit list documents');
  const host = $('#rp-data');
  if (info.region === ALL_INDIA) {
    host.innerHTML = `<div class="rp-soon">${rpSvg('info')}<h3>No separate merit list</h3>
      <p>Your NEET-PG 2026 All India Rank is your place in the queue. See where every rank went in Round 1, or where yours can reach.</p>
      <div class="empty-actions"><a class="btn btn-primary" href="/roadmap/all-india/round-1/allotment" data-link>Round 1 allotments</a>
        <a class="btn btn-line" href="/predict" data-link id="rp-aiq">All India predictor</a></div></div>`;
    $('#rp-aiq').addEventListener('click', () => { S.scope = 'aiq'; store.set('rr-scope', 'aiq'); });
    return;
  }
  if (!d) { host.innerHTML = rpSoon('list', 'Merit list data will be available soon.', `The ${info.region} state merit list will be published here once it is released by the competent authority.`); return; }
  host.insertAdjacentHTML('beforebegin', `<h3 class="rp-sub-title">${esc(d.title)} <small>${esc(shortDate(d.date))}</small></h3>
    ${info.access === 'open' && S.user?.state === info.region ? '<div class="cf-box cf-wide" id="rp-cf"></div>' : ''}`);
  if ($('#rp-cf')) cmrFinder($('#rp-cf'), info.region);
  rpLoad(info, d, host, data => meritExplorer(host, data, info));
}

// ---- Rounds: choice filling (seat matrix), allotment, joining ----
function rpRound(info, box, stage, rest) {
  const v = ROUND_VIEWS.find(x => x[0] === rest[0]) || ROUND_VIEWS[0];
  const pred = info.region === ALL_INDIA || (S.user?.state === info.region && setsOf('state').some(x => x.state === info.region));
  box.innerHTML = rpHead(info, stage, 'users', `Explore the seat matrix, fill choices, and view allotment and joining details for ${stage}.`,
    pred ? `<a class="btn btn-line" href="/predict" data-link data-to-scope="${info.region === ALL_INDIA ? 'aiq' : 'state'}">Open the predictor ${icon.arrowR}</a>` : '')
    + `<div class="rp-round"><nav class="rp-sub" aria-label="${stage}">${ROUND_VIEWS.map(([id, t, s, ic]) =>
      `<a href="/roadmap/${info.key}/${slugOf(stage)}/${id}" data-rp${id === v[0] ? ' aria-current="page"' : ''}>${rpSvg(ic)}<span><b>${t}</b><small>${s}</small></span></a>`).join('')}</nav>
      <div class="rp-round-body" id="rp-data"></div></div>`;
  $('[data-to-scope]', box)?.addEventListener('click', e => { S.scope = e.currentTarget.dataset.toScope; store.set('rr-scope', S.scope); });
  const host = $('#rp-data');
  const kind = { 'choice-filling': 'seats', allotment: 'allotment' }[v[0]];
  const d = kind && info.data.find(x => x.kind === kind && x.round === stage);
  const title = { seats: 'Seat Matrix', allotment: `${stage} allotment` }[kind] || 'Joining status';
  if (!d) {
    const docKind = { seats: 'Seat matrix', allotment: 'Allotment' }[kind];
    const docs = docKind && (stage === info.progress?.stage || stage === 'Round 1') ? info.documents.filter(x => x.kind === docKind) : [];
    host.innerHTML = `<h3 class="rp-sub-title">${title}</h3>` + rpSoon(kind === 'seats' ? 'grid' : kind ? 'check' : 'users', `${title} data will be available soon.`,
      kind === 'seats' ? `The college and specialty-wise seat matrix for ${stage} will be published here once released by the competent authority.`
        : kind ? `${stage} allotments will appear here once the result is out.` : "Joining status is published after each round's reporting closes.")
      + rpDocList(docs, 'Official documents', true);
    return;
  }
  host.innerHTML = `<h3 class="rp-sub-title">${esc(d.title)} <small>${esc(shortDate(d.date))}${d.doc
    ? ` · <a href="/counselling/assets/${esc(d.doc)}" target="_blank" rel="noopener">Official PDF</a>` : ''}</small></h3><div id="rp-x"></div>`;
  const x = $('#rp-x');
  rpLoad(info, d, x, async data => kind === 'seats' ? seatExplorer(x, data, info, await lastYear(info.region).catch(() => null)) : allotExplorer(x, data, info));
}

// A region's data: loaded once it may be seen, otherwise a sign-in or locked card.
async function rpLoad(info, d, host, render) {
  const lock = access => {
    host.innerHTML = rpLock({ ...info, access }, d.title);
    $$('[data-signin]', host).forEach(b => b.onclick = () => openSignIn(location.pathname, b.dataset.signin));
  };
  if (info.access !== 'open') return lock(info.access);
  const ck = info.key + '/' + d.id;
  S.rpData ||= {};
  if (!S.rpData[ck]) {
    host.innerHTML = '<div class="rp-wait"><span class="spinner"></span></div>';
    try { S.rpData[ck] = await api(`/api/regions/${info.key}/data/${d.id}`); }
    catch (e) {
      if (e.status === 401 || e.status === 403) return lock(e.status === 401 ? 'signin' : 'locked');
      host.innerHTML = `<div class="empty"><h3>We couldn't load the data</h3><p>${esc(e.message)}</p></div>`; return;
    }
  }
  if (host.isConnected) await render(S.rpData[ck]);
}
function rpLock(info, what) {
  const own = S.user?.state;
  return info.access === 'signin'
    ? `<div class="rp-lock">${icon.lock}<h3>Sign in to see the ${esc(what.toLowerCase())}</h3>
        <p>It's free. All India data is open to every account, and each state's data to the candidates registered for that state.</p>
        <div class="empty-actions"><button class="btn btn-primary" data-signin="signup">Create a free account</button><button class="btn btn-line" data-signin="signin">Sign in</button></div></div>`
    : `<div class="rp-lock">${icon.lock}<h3>${esc(info.region)} data is for ${esc(info.region)} candidates</h3>
        <p>Your account is registered for ${esc(own)}. You can follow ${esc(info.region)}'s counselling progress, dates and guide here; its data stays locked.
          Access to other states' data is planned as a premium service.</p>
        <div class="empty-actions">${own ? `<a class="btn btn-primary" href="/roadmap/${esc(slugOf(own))}" data-link>Open the ${esc(own)} roadmap</a>` : ''}
          <a class="btn btn-line" href="/roadmap/all-india" data-link>All India data</a></div></div>`;
}

/**
 * A filterable table for a region's data (merit list, seat matrix, allotments). cfg:
 *   rows; prog: { of(r) → 'MD/MS' | 'DNB' | 'Diploma', all: offer "All", value }
 *   segs: [{ id, label, values, of, value }]  rows of buttons
 *   selects: [{ id, label, all, of }]  dropdowns, offered the values left by the buttons
 *   search: { placeholder, of(r) → text }; range: { label, of(r) → number }
 *   find: { label, placeholder, run(n) → html }  look up one rank (it is marked in the table)
 *   cols: [{ t, r(r, i) → html, cls }]; mark(r, f) → highlight; summary(view) → html; csv: { name, head, row }
 *   keep(r) → false hides a row; order(view) → the view sorted. Returns { refresh } to redraw after outside changes.
 */
function explorer(host, cfg) {
  const init = () => ({ prog: cfg.prog?.value ?? '', q: '', lo: 0, hi: 0, find: 0,
    ...Object.fromEntries([...(cfg.segs || []), ...(cfg.selects || [])].map(x => [x.id, x.value ?? ''])) });
  let f = init(), view = [], shown = 0;
  const PAGE = 100, segs = cfg.segs || [], selects = cfg.selects || [];
  const inProg = r => !f.prog || cfg.prog.of(r) === f.prog;
  const base = () => cfg.rows.filter(r => inProg(r) && segs.every(s => !f[s.id] || s.of(r) === f[s.id]));
  const progs = cfg.prog ? new Set(cfg.rows.map(cfg.prog.of)) : null;
  host.innerHTML = `${cfg.intro || ''}
    ${cfg.prog ? `<div class="rp-prog" role="group" aria-label="Programme">${[...(cfg.prog.all ? [['', 'All']] : []), ...PROGS.map(p => [p, p])].map(([v, t]) =>
      `<button type="button" data-p="${v}" aria-pressed="${f.prog === v}"${v && !progs.has(v) ? ' disabled title="Not in this data"' : ''}>${t}</button>`).join('')}</div>` : ''}
    ${cfg.find ? `<form class="rp-find" id="x-find" novalidate><label class="label" for="x-rank">${cfg.find.label}</label>
      <div class="rp-find-row"><input class="input" id="x-rank" inputmode="numeric" autocomplete="off" placeholder="${cfg.find.placeholder}"><button class="btn btn-primary">Find</button></div>
      <p id="x-found" aria-live="polite"></p></form>` : ''}
    <div class="rp-filters">
      ${segs.map(s => `<div class="field${s.values.length > 2 ? ' rp-wide' : ''}"><span class="label">${s.label}</span><div class="seg" role="group" aria-label="${s.label}">${s.values.map(v =>
        `<button type="button" data-s="${s.id}" data-v="${esc(v)}" aria-pressed="${f[s.id] === v}">${esc(v)}</button>`).join('')}</div></div>`).join('')}
      ${selects.map(s => `<label class="field"><span class="label">${s.label}</span><select class="select" data-x="${s.id}"></select></label>`).join('')}
      ${cfg.range ? `<div class="field rp-range"><span class="label">${cfg.range.label}</span><div><input class="input" id="x-lo" inputmode="numeric" placeholder="From" aria-label="From">
        <input class="input" id="x-hi" inputmode="numeric" placeholder="To" aria-label="To"></div></div>` : ''}
      <label class="field rp-q"><span class="label">Search</span><span class="search-wrap">${icon.search}<input class="input" id="x-q" type="search" autocomplete="off"
        placeholder="${esc(cfg.search.placeholder)}"></span></label>
      <div class="field rp-clear"><button type="button" class="btn btn-line" id="x-clear">${icon.filter} Clear filters</button></div>
    </div>
    <div class="rp-sum"><p id="x-sum" aria-live="polite"></p><button type="button" class="btn btn-line btn-sm" id="x-csv">${icon.download} Excel (CSV)</button></div>
    <div class="grid-wrap"><table class="grid rp-grid"><thead><tr>${cfg.cols.map(c => `<th scope="col" class="${c.cls || ''}">${c.t}</th>`).join('')}</tr></thead>
      <tbody id="x-rows"></tbody></table></div>
    <button type="button" class="btn btn-line rp-more" id="x-more" hidden>Show 100 more</button>`;
  const q = sel => host.querySelector(sel);
  // A button row shows only what the programme (and the rows before it) leave; a choice that's gone moves to the first left.
  const syncSegs = () => segs.forEach((s, i) => {
    const have = new Set(cfg.rows.filter(r => inProg(r) && segs.slice(0, i).every(p => !f[p.id] || p.of(r) === f[p.id])).map(s.of));
    if (f[s.id] && !have.has(f[s.id])) f[s.id] = s.values.find(v => have.has(v)) || '';
    host.querySelectorAll(`[data-s="${s.id}"]`).forEach(b => { b.hidden = !have.has(b.dataset.v); b.setAttribute('aria-pressed', String(b.dataset.v === f[s.id])); });
  });
  // Each dropdown offers what the other filters leave, so no combination ends in an empty table.
  const fillSelects = () => {
    const b = base();
    for (const s of selects) {
      const vals = uniq(b.filter(r => selects.every(o => o === s || !f[o.id] || o.of(r) === f[o.id])).map(s.of).filter(Boolean))
        .sort((x, y) => String(x).localeCompare(String(y)));
      if (f[s.id] && !vals.includes(f[s.id])) f[s.id] = '';
      q(`[data-x="${s.id}"]`).innerHTML = `<option value="">${esc(s.all)}</option>` + vals.map(v => `<option${v === f[s.id] ? ' selected' : ''}>${esc(v)}</option>`).join('');
    }
  };
  const run = (reset = true) => {
    if (reset) {
      const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
      view = base().filter(r => selects.every(s => !f[s.id] || s.of(r) === f[s.id])
        && (!terms.length || terms.every(t => cfg.search.of(r).toLowerCase().includes(t)))
        && (!cfg.range || ((!f.lo || cfg.range.of(r) >= f.lo) && (!f.hi || cfg.range.of(r) <= f.hi)))
        && (!cfg.keep || cfg.keep(r)));
      if (cfg.order) view = cfg.order(view);
      shown = 0;
    }
    const next = view.slice(shown, shown + PAGE);
    const html = next.map((r, i) => `<tr${cfg.mark?.(r, f) ? ' class="me"' : ''}>${cfg.cols.map(c => `<td class="${c.cls || ''}">${c.r(r, shown + i)}</td>`).join('')}</tr>`).join('');
    if (reset) q('#x-rows').innerHTML = html || `<tr><td colspan="${cfg.cols.length}" class="rp-none">Nothing matches these filters.</td></tr>`;
    else q('#x-rows').insertAdjacentHTML('beforeend', html);
    shown += next.length;
    q('#x-more').hidden = shown >= view.length;
    q('#x-sum').innerHTML = cfg.summary(view) + (view.length > shown ? ` · showing ${fmt(shown)}` : '');
  };
  const refresh = () => { syncSegs(); fillSelects(); run(); };
  host.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
    f.prog = b.dataset.p;
    host.querySelectorAll('[data-p]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    refresh();
  });
  host.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { f[b.dataset.s] = b.dataset.v; refresh(); });
  host.querySelectorAll('[data-x]').forEach(s => s.onchange = () => { f[s.dataset.x] = s.value; fillSelects(); run(); });
  const later = debounce(() => run(), 200);
  const num = el => parseInt(String(el?.value || '').replace(/\D/g, ''), 10) || 0;
  q('#x-q').oninput = e => { f.q = e.target.value.trim(); later(); };
  if (cfg.range) [q('#x-lo'), q('#x-hi')].forEach(el => el.oninput = () => { f.lo = num(q('#x-lo')); f.hi = num(q('#x-hi')); later(); });
  q('#x-clear').onclick = () => {
    f = { ...init(), prog: f.prog, find: f.find };
    host.querySelectorAll('#x-q, #x-lo, #x-hi').forEach(el => { el.value = ''; });
    refresh();
  };
  q('#x-more').onclick = () => run(false);
  q('#x-csv').onclick = () => { downloadCsv(cfg.csv.name, cfg.csv.head, view.map(cfg.csv.row)); track('export', { mode: 'region-csv', rows: view.length }); };
  if (cfg.find) {
    const find = () => {
      const n = num(q('#x-rank'));
      f.find = n;
      q('#x-found').innerHTML = n ? cfg.find.run(n) : '';
      if (n && cfg.range) { f.lo = Math.max(1, n - 500); f.hi = n + 500; q('#x-lo').value = f.lo; q('#x-hi').value = f.hi; }
      run();
    };
    q('#x-find').onsubmit = e => { e.preventDefault(); find(); };
    q('#x-rank').oninput = debounce(find, 350);
  }
  refresh();
  return { refresh };
}

// A list of candidates turned away ("Rejected", "Not eligible …"): no ranks, a reason instead.
const rejectedList = l => l.type === 'Rejected' || !!l.rejected;
const stateRank = r => r.rl || (r.ranks?.UR ? fmt(r.ranks.UR) : '—');

// State merit lists. Rows: name, roll / app, cat, sub, score, weight (bonus or incentive marks), total, air, ranks
// ({ UR: state rank, <category>: rank }), and where a state gives them: rl (a rank such as "1980A"), note (candidate
// type), tags (eligibility), job, reason. Fields a list lacks are left out.
function meritExplorer(host, data, info) {
  const rows = data.lists.flatMap(l => l.rows.map(r => ({ ...r, _l: l })));
  const has = k => rows.some(r => r[k] != null && r[k] !== '');
  const catName = c => (c || '').replace(/,.*$/, '').replace(/^SEBC - Non Creamy Layer$/, 'SEBC').replace(/^Qualified OBC.*$/, 'OBC (central list)');
  const pwd = r => /PWD/i.test(r.sub || '') ? 'Yes' : '';
  const score = r => r.total == null ? '—' : r.weight ? `${fmt(r.total)}<span class="sub">${fmt(r.score)} + ${fmt(r.weight)} ${r.wpct ? `(${r.wpct}%)` : 'bonus'}</span>` : fmt(r.total);
  const ctype = r => r.note || r._l.type;
  const remarks = r => rejectedList(r._l) ? `<span class="rp-bad">${esc(r.reason || 'Rejected')}</span>`
    : [...Object.entries(r.ranks || {}).filter(([k]) => k !== 'UR').map(([k, n]) => `<span class="rp-chip">${esc(k)} ${fmt(n)}</span>`),
      ...(r.tags || []).map(t => `<span class="rp-chip rp-tag${/^Not eligible/.test(t) ? ' rp-tag-bad' : ''}">${esc(t)}</span>`),
      ...(r.reason ? [`<span class="sub">${esc(r.reason)}</span>`] : [])].join(' ') || '—';
  const notes = new Set(rows.map(r => r.note).filter(Boolean));
  const named = has('name'), ids = r => [r.roll && `Roll ${esc(r.roll)}`, r.app && `Appl. ${esc(r.app)}`].filter(Boolean);
  explorer(host, {
    rows,
    prog: { of: r => r._l.programme, value: data.lists[0].programme },
    segs: data.lists.length > 1 ? [{ id: 'type', label: notes.size > 1 ? 'List' : 'Candidate type', values: [...new Set(data.lists.map(l => l.type))], of: r => r._l.type, value: data.lists[0].type }] : [],
    selects: [{ id: 'cat', label: 'Category', all: 'All categories', of: r => catName(r.cat) },
      ...(notes.size > 1 ? [{ id: 'note', label: 'Candidate type', all: 'All candidates', of: r => r.note }] : [])],
    search: { placeholder: named ? `Search by name${has('roll') ? ', NEET roll no.' : ''}${has('app') ? ' or application no.' : ''}` : 'Search by application no. or NEET roll no.',
      of: r => `${r.name || ''} ${r.roll || ''} ${r.app || ''}` },
    mark: (r, f) => /^\w{8,}$/.test(f.q) && (r.roll === f.q || r.app === f.q),
    cols: [
      { t: '#', cls: 'n soft', r: (r, i) => fmt(i + 1) },
      ...(has('air') ? [{ t: 'AIR', cls: 'n', r: r => r.air ? fmt(r.air) : '—' }] : []),
      { t: 'State rank', cls: 'n strong', r: r => esc(stateRank(r)) },
      named ? { t: 'Name', cls: 'wrapcell', r: r => `<b>${esc(r.name)}</b><span class="sub">${ids(r).join(' · ')}</span>` }
        : { t: 'Candidate', cls: 'wrapcell', r: r => `<b>${r.app ? `Appl. ${esc(r.app)}` : '—'}</b>${r.roll ? `<span class="sub">Roll ${esc(r.roll)}</span>` : ''}` },
      { t: 'Category', cls: 'wrapcell', r: r => esc(catName(r.cat) || '—') + (r.sub ? `<span class="sub">${esc(r.sub.replace(/PWD- Persons with Disabilities/i, 'PwD'))}</span>` : '') },
      { t: 'PwD', r: r => pwd(r) || '—' },
      { t: 'Candidate type', cls: 'wrapcell', r: r => esc(ctype(r)) + (r.job ? `<span class="sub">${esc(r.job.toLowerCase())}</span>` : '') },
      ...(has('total') ? [{ t: `Score <span class="sub">out of ${data.scoreOutOf || 800}</span>`, cls: 'n', r: score }] : []),
      { t: 'Remarks', cls: 'wrapcell', r: remarks }
    ],
    summary: v => `<b>${fmt(v.length)}</b> candidate${v.length === 1 ? '' : 's'}${data.note ? ` · <span class="muted">${esc(data.note)}</span>` : ''}`,
    csv: { name: `${slugOf(info.region)}-merit-list-2026.csv`, head: ['List', 'State rank', 'NEET AIR', 'Name', 'NEET roll no.', 'Application no.', 'Category', 'Sub-category', 'PwD', 'Candidate type', 'NEET score', 'Bonus', 'Total', 'Category ranks', 'Remarks'],
      row: r => [r._l.label, r.rl || r.ranks?.UR || '', r.air || '', r.name || '', r.roll || '', r.app || '', catName(r.cat), r.sub || '', pwd(r), ctype(r), r.score ?? '', r.weight || '', r.total ?? '',
        Object.entries(r.ranks || {}).map(([k, n]) => `${k} ${n}`).join('; '), [...(r.tags || []), r.reason || r.job || ''].filter(Boolean).join('; ')] }
  });
}

// Last year's state counselling closing ranks for the candidate's own state (the predictor's data), to grade each
// seat of this year's matrix; null when there are none.
async function lastYear(region) {
  const set = setsOf('state').filter(d => d.state === region).sort((a, b) => b.year - a.year)[0];
  if (!set || S.user?.state !== region) return null;
  S.lastYear ||= {};
  if (!S.lastYear[set.id]) {
    const r = await api('/api/datasets/' + set.id);
    S.lastYear[set.id] = { dataset: r.dataset, rows: r.rows.map(a => Object.fromEntries(r.columns.map((c, i) => [c, a[i]]))) };
  }
  return S.lastYear[set.id];
}

function seatExplorer(host, data, info, prev = null) {
  const rows = data.rows, has = k => rows.some(r => r[k]);
  const baseCat = c => c.replace(/\s*\(.*\)$/, '');
  const many = k => new Set(rows.map(r => r[k])).size;
  // A 2026 seat's 2025 counterpart: the same college, course, stream and category ("SC (Green Card)" was "Green Card",
  // management seats "UR"); failing that, the same seat's unreserved closing rank, a stricter yardstick for a reserved seat.
  const cat0 = c => (/\((.*)\)/.exec(c) || [])[1] || (c === 'Open' ? 'UR' : c);
  const past = new Map();
  for (const r of prev?.rows || []) {
    const k = [r.college, r.speciality, progOf(r.programme), r.stream, r.category].join('|'), o = past.get(k);
    if (!o || r.cmr_close > o.cmr_close) past.set(k, r);
  }
  const refOf = r => {
    const k = c => [r.college, r.course, progOf(r.programme), r.stream, c].join('|');
    const open = past.get(k('UR')) || past.get(k('OPEN')); // Gujarat calls its unreserved seats OPEN
    return r._ref ??= past.get(k(cat0(r.category))) ? { p: past.get(k(cat0(r.category))), same: true } : open ? { p: open, same: false } : null;
  };
  const p = { rank: parseInt(S.user?.cmr, 10) || 0, reach: false };
  const chance = r => { const x = refOf(r); return x && p.rank ? band(p.rank, x.p.cmr_open, x.p.cmr_close) : 0; };
  const year = prev?.dataset.year;
  const predCols = prev ? [
    { t: `${year} closing CMR`, cls: 'n', r: r => { const x = refOf(r); return x ? `${fmt(x.p.cmr_close)}<span class="sub">${x.same ? 'same seat' : `${esc(x.p.category === 'OPEN' ? 'OPEN' : 'UR')} seat; no ${esc(cat0(r.category))} seat in ${year}`}</span>` : `—<span class="sub">new seat</span>`; } },
    { t: 'Your chance', r: r => !p.rank ? '<span class="muted">Enter your CMR</span>' : refOf(r) ? bandHtml(chance(r)) || '<span class="muted">Out of reach</span>' : '<span class="muted">No history</span>' }
  ] : [];
  const x = explorer(host, {
    rows,
    intro: prev ? `<div class="rp-pred">
      <label class="field"><span class="label">Your ${esc(info.region)} CMR</span><input class="input input-rank" id="x-cmr" inputmode="numeric" autocomplete="off" value="${p.rank || ''}" placeholder="e.g. 250"></label>
      <div><p><b>Your chances, seat by seat.</b> Each ${new Date().getFullYear()} seat is graded against its ${year} closing rank (${esc(prev.dataset.label)}): Very high, High, Moderate or Low,
        as on the predictor. Pick your candidate type and category below; the CMR restarts at 1 in each stream.</p>
        <label class="check"><input type="checkbox" id="x-reach"> Only seats in reach, best chances first</label>
        <div class="cf-box" id="x-cf"></div></div></div>` : '',
    prog: { of: r => progOf(r.programme), value: 'MD/MS' },
    segs: has('stream') ? [{ id: 'stream', label: 'Candidate type', values: ['Direct', 'In-service'], of: r => r.stream, value: 'Direct' }] : [],
    selects: [
      ...(has('state') ? [{ id: 'state', label: 'State', all: 'All states', of: r => r.state }] : []),
      ...(many('college') <= 300 ? [{ id: 'college', label: 'Institution', all: 'All institutions', of: r => r.college }] : []),
      { id: 'type', label: 'College type', all: 'All (Govt + Private)', of: r => r.type },
      ...(many('quota') > 2 ? [{ id: 'quota', label: 'Quota', all: 'All quotas', of: r => r.quota }] : []),
      { id: 'cat', label: 'Category', all: 'All categories', of: r => baseCat(r.category) },
      ...(many('course') > 1 ? [{ id: 'course', label: 'Course', all: 'All courses', of: r => r.course }] : [])],
    search: { placeholder: has('state') ? 'Search by institute, city or course (e.g. Apollo, Hyderabad, Radio Diagnosis)'
      : 'Search by college, course or branch (e.g. SCB, Radiodiagnosis, General Medicine)', of: r => `${r.college} ${r.course} ${r.category} ${r.quota} ${r.state || ''}` },
    keep: r => !p.reach || chance(r) > 0,
    order: v => p.reach ? [...v].sort((a, b) => chance(b) - chance(a) || refOf(b).p.cmr_close - refOf(a).p.cmr_close) : v,
    cols: [
      { t: '#', cls: 'n soft', r: (r, i) => fmt(i + 1) },
      { t: 'Institution', cls: 'strong wrapcell', r: r => `${esc(r.college)}<span class="sub">${esc([r.type, r.state].filter(Boolean).join(' · '))}</span>` },
      { t: 'Course', cls: 'wrapcell', r: r => `${esc(r.course)}<span class="sub">${esc(r.programme)}</span>` },
      { t: 'Quota', cls: 'wrapcell', r: r => esc(r.quota) + (r.stream ? `<span class="sub">${esc(r.stream)}</span>` : '') },
      { t: 'Category', r: r => esc(r.category) },
      { t: 'Total seats', cls: 'n r strong', r: r => fmt(r.seats) },
      ...(has('fee') ? [{ t: 'Fee <span class="sub">as published</span>', cls: 'n', r: r => r.fee ? `₹${fmt(r.fee)}` : '—' }] : []),
      ...predCols
    ],
    summary: v => `<b>${fmt(v.reduce((n, r) => n + r.seats, 0))}</b> seats in ${(n => `${fmt(n)} institution${n === 1 ? '' : 's'}`)(new Set(v.map(r => r.college)).size)}${data.note ? ` · <span class="muted">${esc(data.note)}</span>` : ''}`,
    csv: { name: `${slugOf(info.region)}-seat-matrix.csv`,
      head: ['Institution', 'College type', 'State', 'Course', 'Programme', 'Candidate type', 'Quota', 'Category', 'Seats', ...(has('fee') ? ['Fee (Rs)'] : []), ...(prev ? [`${year} closing CMR`, 'Your chance'] : [])],
      row: r => [r.college, r.type, r.state || '', r.course, r.programme, r.stream || '', r.quota, r.category, r.seats, ...(has('fee') ? [r.fee || ''] : []),
        ...(prev ? [refOf(r)?.p.cmr_close || '', p.rank && refOf(r) ? BAND[chance(r)] || 'Out of reach' : ''] : [])] }
  });
  if (!prev) return;
  const cmr = host.querySelector('#x-cmr');
  cmrFinder(host.querySelector('#x-cf'), info.region, { onSet: n => { cmr.value = n; p.rank = n; x.refresh(); } });
  cmr.oninput = debounce(() => { cmr.value = cmr.value.replace(/\D/g, '').slice(0, 7); p.rank = parseInt(cmr.value, 10) || 0; x.refresh(); }, 250);
  host.querySelector('#x-reach').onchange = e => { p.reach = e.target.checked; x.refresh(); };
}

// A state's allotment: rows of { rank (place on the state merit list), air, college, type, course, programme, quota,
// category (the seat's), cand (the candidate's category), note (candidate type), pref / prefs (choice allotted, choices filled),
// list (when a state ranks programmes separately) }.
function stateAllotExplorer(host, D, info) {
  const rows = D.rows, has = k => rows.some(r => r[k] != null && r[k] !== '');
  const many = k => new Set(rows.map(r => r[k])).size;
  const count = p => rows.filter(r => r.programme === p).length;
  const label = D.rankLabel || 'State rank';
  explorer(host, {
    rows,
    intro: `<div class="rp-stats">${[[rows.length, 'seats allotted'], ...PROGS.filter(count).map(p => [count(p), p])].map(([n, t]) => `<div><b>${fmt(n)}</b><span>${t}</span></div>`).join('')}</div>`,
    prog: { of: r => r.programme, all: true, value: '' },
    selects: [
      ...(many('college') <= 300 ? [{ id: 'college', label: 'Institution', all: 'All institutions', of: r => r.college }] : []),
      { id: 'type', label: 'College type', all: 'All (Govt + Private)', of: r => r.type },
      ...(many('quota') > 1 ? [{ id: 'quota', label: 'Quota', all: 'All quotas', of: r => r.quota }] : []),
      { id: 'cat', label: 'Seat category', all: 'All categories', of: r => r.category.replace(/\s*\(.*\)$/, '') },
      { id: 'course', label: 'Course', all: 'All courses', of: r => r.course },
      ...(has('note') && many('note') > 1 ? [{ id: 'note', label: 'Candidate type', all: 'All candidates', of: r => r.note }] : [])],
    search: { placeholder: 'College or course (e.g. Medical College, Radiodiagnosis)', of: r => `${r.college} ${r.course}` },
    range: { label: `${label} range`, of: r => r.rank },
    find: { label: `Find your ${label}`, placeholder: 'e.g. 250', run: n => {
      const hit = rows.filter(x => x.rank === n);
      if (hit.length) return hit.map(r => `${esc(label)} <b>${esc(r.rl || fmt(n))}</b>${r.list ? ` (${esc(r.list)} list)` : r.note ? ` (${esc(r.note)})` : ''} was allotted <b>${esc(r.course)}</b> at <b>${esc(r.college)}</b> · ${esc(r.quota)} · ${esc(r.category)}.`).join('<br>') + ' Nearby ranks are listed below.';
      const after = rows.find(x => x.rank > n);
      return `${esc(label)} <b>${fmt(n)}</b> was not allotted a seat in this round.${after ? ` The next allotted rank is ${fmt(after.rank)}.` : ''} Nearby ranks are listed below.`;
    } },
    mark: (r, f) => r.rank === f.find,
    cols: [
      { t: esc(label), cls: 'n strong', r: r => esc(r.rl || fmt(r.rank)) + (r.air ? `<span class="sub">AIR ${fmt(r.air)}</span>` : '') },
      { t: 'Institution', cls: 'wrapcell', r: r => `<b>${esc(r.college)}</b><span class="sub">${esc(r.type)}</span>` },
      { t: 'Course', cls: 'wrapcell', r: r => `${esc(r.course)}<span class="sub">${esc(r.programme)}${r.list && r.list !== r.programme ? ` · ${esc(r.list)} list` : ''}</span>` },
      { t: 'Quota', cls: 'wrapcell', r: r => esc(r.quota) },
      { t: 'Category', cls: 'wrapcell', r: r => esc(r.category) + (r.cand && r.cand !== r.category ? `<span class="sub">Candidate: ${esc(r.cand)}</span>` : '') },
      ...(has('note') ? [{ t: 'Candidate type', cls: 'wrapcell', r: r => esc(r.note || '—') }] : []),
      ...(has('pref') ? [{ t: 'Choice', cls: 'n', r: r => r.pref ? `${fmt(r.pref)}${r.prefs ? `<span class="sub">of ${fmt(r.prefs)}</span>` : ''}` : '—' }] : []),
      ...(has('fee') ? [{ t: 'Course fee <span class="sub">as published</span>', cls: 'n', r: r => r.fee ? `₹${fmt(r.fee)}` : '—' }] : [])
    ],
    summary: v => v.length ? `<b>${fmt(v.length)}</b> seat${v.length === 1 ? '' : 's'} · ${esc(label.toLowerCase())}s <b>${fmt(Math.min(...v.map(r => r.rank)))}</b> to <b>${fmt(Math.max(...v.map(r => r.rank)))}</b>${D.note ? ` · <span class="muted">${esc(D.note)}</span>` : ''}`
      : 'No seats match these filters.',
    csv: { name: `${slugOf(info.region)}-round1-allotment.csv`, head: [label, 'NEET AIR', 'List', 'College', 'College type', 'Programme', 'Course', 'Quota', 'Seat category', 'Candidate category', 'Candidate type', 'Choice allotted', 'Choices filled', ...(has('fee') ? ['Course fee (Rs)'] : [])],
      row: r => [r.rl || r.rank, r.air || '', r.list || '', r.college, r.type, r.programme, r.course, r.quota, r.category, r.cand || '', r.note || '', r.pref || '', r.prefs || '', ...(has('fee') ? [r.fee || ''] : [])] }
  });
  if (D.vacant?.length) vacantSeats(host, D.vacant);
}

// Seats a state lists as lying vacant after the round: { college, type, course, programme, quota, category, stream, seats }.
function vacantSeats(host, rows) {
  const n = rows.reduce((a, r) => a + r.seats, 0);
  const streams = [...new Set(rows.map(r => r.stream).filter(Boolean))];
  host.insertAdjacentHTML('beforeend', `<details class="rp-vacant"><summary><b>${fmt(n)}</b> seat${n === 1 ? '' : 's'} lying vacant after this round${streams.length > 1
      ? ` <span class="muted">(${streams.map(s => `${fmt(rows.filter(r => r.stream === s).reduce((a, r) => a + r.seats, 0))} ${esc(s.toLowerCase())}`).join(', ')})</span>` : ''}</summary>
    <div class="grid-wrap"><table class="grid rp-grid"><thead><tr><th scope="col">Institution</th><th scope="col">Course</th>
      <th scope="col">Quota</th><th scope="col">Category</th><th scope="col" class="n">Seats</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td class="wrapcell"><b>${esc(r.college)}</b><span class="sub">${esc(r.type || '')}</span></td>
      <td class="wrapcell">${esc(r.course)}<span class="sub">${esc(r.programme)}</span></td>
      <td class="wrapcell">${esc(r.quota)}${r.stream ? `<span class="sub">${esc(r.stream)}</span>` : ''}</td><td class="wrapcell">${esc(r.category)}</td><td class="n strong">${fmt(r.seats)}</td></tr>`).join('')}</tbody></table></div></details>`);
}

// MCC's result in its compact form: lists of names, and rows of [rank, inst, state, quota, course, seat cat, candidate cat, college type].
function allotExplorer(host, D, info) {
  if (D.format === 'state') return stateAllotExplorer(host, D, info);
  const at = (k, i) => D[k]?.[i] ?? '';
  const prog = r => progOf(D.course[r[4]]);
  const count = p => D.rows.filter(r => prog(r) === p).length;
  explorer(host, {
    rows: D.rows,
    intro: `<div class="rp-stats">${[[D.rows.length, 'seats allotted'], ...PROGS.map(p => [count(p), p])].map(([n, t]) => `<div><b>${fmt(n)}</b><span>${t}</span></div>`).join('')}</div>`,
    prog: { of: prog, all: true, value: '' },
    selects: [{ id: 'state', label: 'State', all: 'All states', of: r => at('state', r[2]) },
      { id: 'type', label: 'College type', all: 'All (Govt + Private)', of: r => at('type', r[7]) },
      { id: 'quota', label: 'Quota', all: 'All quotas', of: r => at('quota', r[3]) },
      { id: 'cat', label: 'Category', all: 'All categories', of: r => at('cat', r[5]) },
      { id: 'course', label: 'Course', all: 'All courses', of: r => at('course', r[4]) }],
    search: { placeholder: 'College name (e.g. Sir Ganga Ram, AIIMS, SCB)', of: r => `${D.inst[r[1]]} ${D.full[r[1]]}` },
    range: { label: 'AIR range', of: r => r[0] },
    find: { label: 'Find your All India Rank', placeholder: 'e.g. 12450', run: n => {
      const r = D.rows.find(x => x[0] === n);
      if (r) return `Rank <b>${fmt(n)}</b> was allotted <b>${esc(D.course[r[4]])}</b> at <b>${esc(D.inst[r[1]])}</b>, ${esc(D.state[r[2]])} · ${esc(D.quota[r[3]])} · ${esc(D.cat[r[5]])}. Nearby ranks are listed below.`;
      const after = D.rows.find(x => x[0] > n);
      return `Rank <b>${fmt(n)}</b> was not allotted a seat in Round 1.${after ? ` The next allotted rank is ${fmt(after[0])}.` : ''} Nearby ranks are listed below.`;
    } },
    mark: (r, f) => r[0] === f.find,
    cols: [
      { t: 'AIR', cls: 'n strong', r: r => fmt(r[0]) },
      { t: 'Institution', cls: 'wrapcell', r: r => `<b>${esc(D.inst[r[1]])}</b><span class="sub">${esc(D.full[r[1]])}</span>` },
      { t: 'State', r: r => esc(D.state[r[2]]) },
      { t: 'Course', cls: 'wrapcell', r: r => esc(D.course[r[4]]) },
      { t: 'Quota', cls: 'wrapcell', r: r => `${esc(D.quota[r[3]])}<span class="sub">${esc(at('type', r[7]))}</span>` },
      { t: 'Category', r: r => { const seat = D.cat[r[5]], cand = D.cand[r[6]];
        return esc(seat) + (cand.replace('General', 'OPEN').toUpperCase() !== seat.toUpperCase() ? `<span class="sub">Candidate: ${esc(cand)}</span>` : ''); } }
    ],
    summary: v => v.length ? `<b>${fmt(v.length)}</b> seat${v.length === 1 ? '' : 's'} · ranks <b>${fmt(v[0][0])}</b> to <b>${fmt(v[v.length - 1][0])}</b>${v.length < D.rows.length ? ' (opening to closing rank for this selection)' : ''}`
      : 'No seats match these filters.',
    csv: { name: 'neet-pg-2026-round1-result.csv', head: ['AIR', 'College', 'Full name', 'State', 'College type', 'Programme', 'Course', 'Quota', 'Seat category', 'Candidate category'],
      row: r => [r[0], D.inst[r[1]], D.full[r[1]], D.state[r[2]], at('type', r[7]), prog(r), D.course[r[4]], D.quota[r[3]], D.cat[r[5]], D.cand[r[6]]] }
  });
}

// =====================================================================
// Gate, home, method
// =====================================================================
function viewGate(p) {
  const what = { '/predict': 'the predictor', '/cutoffs': 'the cut-off tables', '/shortlist': 'your shortlist', '/seats': 'the seat matrix of India' }[p];
  S.intended = p;
  view.innerHTML = `<div class="gate">
    <div class="eyebrow" style="display:inline-flex;gap:8px;align-items:center">${icon.lock.replace('<svg', '<svg style="width:13px;height:13px"')} Members' tool</div>
    <h1>Sign up to open ${what}</h1>
    <p>Your name, mobile or email, NEET-PG rank and state — then one code. We'll show cut-offs for your state.</p>
    <div class="auth-card" id="gate-auth"></div>
  </div>`;
  mountAuth($('#gate-auth'), { mode: 'signup' });
}

// ---- coverage map (home page) ---------------------------------------------
// States with a guide are marked, and states with predictor data more strongly. Hovering (or
// focusing, or tapping) a state shows its name and the seats we hold figures for; a state with a
// guide opens it on click. Boundaries: DataMeet (CC BY 4.0), built into /data/india-map.json.
let mapShapes = null;
const SMALL_AREA = ['Chandigarh', 'Delhi', 'Goa', 'Puducherry', 'Dadra and Nagar Haveli and Daman and Diu', 'Lakshadweep', 'Sikkim', 'Tripura'];
async function coverageMap(box) {
  try {
    [mapShapes, S.guideIndex] = await Promise.all([mapShapes || api('/data/india-map.json'), S.guideIndex || api('/api/guides')]);
  } catch { box.remove(); return; }
  if (!box.isConnected) return;
  const { guides, seats } = S.guideIndex;
  const kinds = seats?.kinds || {}, figures = seats?.states || {};
  const withData = new Set(S.cfg.stateData || []);
  const info = Object.fromEntries(Object.keys(mapShapes.states).map(st => {
    const gs = guides.filter(g => g.region === st), f = figures[st] || {};
    const parts = Object.keys(kinds).filter(k => f[k]).map(k => [kinds[k], f[k]]);
    return [st, { gs, parts, note: f.note || '', total: parts.reduce((n, [, v]) => n + v, 0),
      level: withData.has(st) && gs.length ? 'data' : gs.length ? 'guide' : 'none' }];
  }));
  const covered = Object.keys(info).filter(st => info[st].level !== 'none').sort();
  const tracked = Object.values(info).reduce((n, i) => n + i.total, 0);
  const label = st => { const i = info[st]; return `${st}: ${i.total ? `${fmt(i.total)} seats in our data` : 'no seat figures yet'}${i.gs.length ? `, ${i.gs.length} guide${i.gs.length > 1 ? 's' : ''}` : ''}`; };
  box.innerHTML = `
    <div class="cov-in">
      <div class="cov-copy">
        <div class="eyebrow">Coverage · NEET-PG 2026</div>
        <h2>${covered.length} states and union territories, on one map.</h2>
        <p>Hover over or tap a state to see the seats we hold figures for. Marked states open their counselling guide.</p>
        <div class="cov-figs">
          <div><strong>${fmt(tracked)}</strong><span>PG seats in our data</span></div>
          <div><strong>${fmt(guides.length)}</strong><span>counselling guides</span></div>
        </div>
        <ul class="cov-key">
          <li><i class="k-data"></i>Guide and state rank predictor</li>
          <li><i class="k-guide"></i>Counselling guide</li>
          <li><i class="k-none"></i>Seat figures only</li>
        </ul>
      </div>
      <div class="cov-chips" aria-label="States with a guide">${covered.map(st =>
        `<a href="/counselling/${esc(info[st].gs[0].slug)}" data-st="${esc(st)}" class="lv-${info[st].level}">${esc(st.replace('Dadra and Nagar Haveli and Daman and Diu', 'DNH & DD'))}</a>`).join('')}</div>
      <div class="cov-map">
        <svg viewBox="${mapShapes.viewBox}" role="group" aria-label="Map of India by state">
          ${Object.entries(mapShapes.states).map(([st, d]) => {
            const i = info[st], link = i.gs.length;
            return `<path d="${d}" class="lv-${i.level}" data-st="${esc(st)}"${link ? ` tabindex="0" role="link" aria-label="${esc(label(st))}"` : ''}><title>${esc(label(st))}</title></path>`;
          }).join('')}
          ${SMALL_AREA.filter(st => mapShapes.centers[st]).map(st => { const [x, y] = mapShapes.centers[st];
            return `<circle cx="${x}" cy="${y}" r="7" class="cov-hit" data-st="${esc(st)}" aria-hidden="true"/><circle cx="${x}" cy="${y}" r="2.6" class="cov-pin lv-${info[st].level}" data-st="${esc(st)}" aria-hidden="true"/>`; }).join('')}
        </svg>
        <div class="cov-tip" id="cov-tip" role="status" hidden></div>
        <p class="cov-src">Boundaries: <a href="https://github.com/datameet/maps" target="_blank" rel="noopener">DataMeet</a> (CC BY 4.0).
          Seat figures: state guides and the DNB, deemed and central seat matrices.</p>
      </div>
    </div>`;
  const map = $('.cov-map', box), tip = $('#cov-tip', box);
  let current = null, tapped = null;
  const show = (st, x, y) => {
    const i = info[st];
    if (current !== st) {
      current = st;
      $$('[data-st]', box).forEach(el => el.classList.toggle('on', el.dataset.st === st));
      tip.innerHTML = `
        <b class="cov-tip-name">${esc(st)}</b>
        <span class="cov-tip-tags">${i.level === 'data' ? '<em class="t-data">State rank predictor</em>' : ''}${i.gs.length ? `<em>${i.gs.length} guide${i.gs.length > 1 ? 's' : ''}</em>` : '<em class="t-none">Guide coming soon</em>'}</span>
        <strong class="cov-tip-total">${i.total ? fmt(i.total) : '—'}<small>${i.total ? 'PG seats in our data' : 'no seat figures yet'}</small></strong>
        ${i.parts.length ? `<dl>${i.parts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${fmt(v)}</dd></div>`).join('')}</dl>` : ''}
        ${i.note ? `<p>${esc(i.note)}</p>` : ''}
        ${i.gs.length ? `<span class="cov-tip-go">${matchMedia('(hover: none)').matches ? 'Tap again' : 'Click'} to open its counselling roadmap ${icon.arrowR}</span>` : ''}`;
      tip.hidden = false;
    }
    const r = map.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    let left = x - r.left + 16, top = y - r.top + 16;
    if (left + w > r.width - 8) left = x - r.left - w - 16;
    if (top + h > r.height - 8) top = Math.max(8, y - r.top - h - 16);
    tip.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
  };
  const hide = () => { current = tapped = null; tip.hidden = true; $$('.on', box).forEach(el => el.classList.remove('on')); };
  const open = st => { if (info[st]?.gs.length) { track('map', { state: st }); go(`/roadmap/${slugOf(st)}`); } };
  map.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch') return;
    const st = e.target.closest?.('[data-st]')?.dataset.st;
    st ? show(st, e.clientX, e.clientY) : hide();
  });
  map.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch') hide(); });
  map.addEventListener('click', e => {
    const st = e.target.closest?.('[data-st]')?.dataset.st;
    if (!st) { hide(); return; }
    // On touch screens the first tap shows the card and the second opens the guide.
    if (matchMedia('(hover: none)').matches && tapped !== st) { tapped = st; show(st, e.clientX, e.clientY); return; }
    open(st);
  });
  const atCenter = st => { const el = $(`path[data-st="${CSS.escape(st)}"]`, map).getBoundingClientRect(); return [el.left + el.width / 2, el.top + el.height / 2]; };
  map.addEventListener('focusin', e => { const st = e.target.dataset?.st; if (st) show(st, ...atCenter(st)); });
  map.addEventListener('focusout', hide);
  map.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset?.st) open(e.target.dataset.st); });
  // The chip list mirrors the map: hovering a chip lights up its state.
  $('.cov-chips', box).addEventListener('pointerover', e => { const st = e.target.closest('[data-st]')?.dataset.st; if (st) show(st, ...atCenter(st)); });
  $('.cov-chips', box).addEventListener('pointerleave', hide);
}

function viewHome() {
  // Latest published dataset per state, so several years don't double count.
  const latest = kind => { const seen = new Set(); return (S.cfg.datasets || []).filter(d => d.kind === kind && !seen.has(d.state) && seen.add(d.state)); };
  const total = (list, k) => list.reduce((n, d) => n + (d[k] || 0), 0);
  // All India: the national dataset when there is one (it already holds every state's colleges).
  const national = (S.cfg.datasets || []).find(d => d.kind === 'aiq' && d.state === ALL_INDIA);
  const st = latest('state'), aq = national ? [national] : latest('aiq'), covered = S.cfg.dataStates || [], stateCov = S.cfg.stateData || [];
  const year = st[0]?.year || 2025;
  view.innerHTML = `
  ${(h => `<a class="priority" href="${esc(h.href)}"${appRoute(h.href) ? ' data-link' : ''}><div class="priority-in">
    <span class="eyebrow">${esc(h.eyebrow)}</span>
    <b>${esc(h.text)}</b>
    <span class="priority-go">${esc(h.go)} ${icon.arrowR}</span>
  </div></a>`)(S.cfg.highlight
    ? { eyebrow: 'NEET-PG 2026 counselling', go: 'Open', ...S.cfg.highlight }
    : { href: '/counselling', eyebrow: 'NEET-PG 2026 counselling', text: guideBanner(), go: 'Open the guide' })}
  <section class="hero"><div class="hero-in">
    <div class="hero-copy">
      <div class="eyebrow">NEET-PG counselling · state quota and All India Quota</div>
      <h1>Know where your rank lands <em>before</em> you lock a choice.</h1>
      <p class="hero-lede">Every seat in your state's counselling and the All India Quota — by college, speciality, stream and
        category — with the ranks that actually got in. Sign up with your NEET-PG rank and state to see what was within reach.</p>
      <div class="hero-cta"><a class="btn btn-line btn-lg" href="/method" data-link>How it works</a></div>
    </div>
    <div class="hero-arrow" aria-hidden="true">
      <span>Start here<small>free · takes a minute</small></span>
      <svg viewBox="0 0 160 120" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M8 98 C 40 104, 92 96, 140 54"/><path d="M106 50 L 142 52 L 134 88"/></svg>
    </div>
    <div class="auth-card hero-auth" id="home-auth">
      <div class="auth-card-head"><span class="eyebrow" id="ha-eye"></span><h2 id="ha-title"></h2></div>
      <div id="home-auth-body"></div>
    </div>
  </div></section>

  <section class="stats"><div class="stats-in">
    <div class="stat"><span class="eyebrow">State admissions</span><strong>${fmt(total(st, 'seats'))}</strong><span>${fmt(total(st, 'colleges'))} colleges, direct and in-service</span></div>
    <div class="stat"><span class="eyebrow">All India Quota</span><strong>${fmt(total(aq, 'seats'))}</strong><span>admissions in ${fmt(total(aq, 'colleges'))} colleges</span></div>
    <div class="stat"><span class="eyebrow">Seat groups</span><strong>${fmt(total(st, 'rows') + total(aq, 'rows'))}</strong><span>college × speciality × category cut-offs</span></div>
    <div class="stat"><span class="eyebrow">States with data</span><strong>${fmt(covered.length)}</strong><span>${stateCov.length ? `State counselling: ${esc(stateCov.join(', '))}` : 'State counselling being added'}${national ? ' · All India Quota: every state' : aq.length ? ` · All India: ${fmt(aq.length)} states` : ''}</span></div>
  </div></section>

  <section class="cov" id="coverage" aria-label="Coverage by state"><div class="cov-in"><div class="empty"><span class="spinner"></span></div></div></section>

  <section class="section">
    <div class="section-head">
      <div><div class="eyebrow">How it works</div><h2>Three steps from rank to a choice list.</h2></div>
      <p>RankRound reads last year's admission results so you can see which seats your rank would have reached — and how
        comfortably — before you spend a single preference on them.</p>
    </div>
    <div class="steps">
      <div class="step"><span class="num">01</span><h3>Sign up with your rank</h3><p>Your NEET-PG rank (All India Rank) and your state. For state counselling we find your state CMR on the state merit list, or you type it in. Pick your stream and category.</p></div>
      <div class="step"><span class="num">02</span><h3>See what was in reach</h3><p>Every seat in your state that closed at or past your rank, graded from very high to low, with the margin and the round it went in.</p></div>
      <div class="step"><span class="num">03</span><h3>Build your shortlist</h3><p>Star seats, put them in preference order, and export or print the list to take into choice filling.</p></div>
    </div>
  </section>

  <section class="section" style="padding-top:0">
    <div class="section-head">
      <div><div class="eyebrow">Reading the chance</div><h2>Graded against the real range.</h2></div>
      <p>Each seat has the best and worst rank admitted in ${esc(year)}. Where your rank falls in that range sets the grade.
        It is history, not a forecast — cut-offs move every round and every year.</p>
    </div>
    <div class="band-key">
      ${[[4, 'Your rank is better than the best rank admitted.'], [3, 'Inside the front half of the admitted range.'],
        [2, 'Inside the back half — close to the cut-off.'], [1, 'Up to 15% past the closing rank. A stretch.']]
        .map(([b, t]) => `<div>${bandHtml(b)}<p>${t}</p></div>`).join('')}
    </div>
  </section>

  <section class="cta-band"><div class="section">
    <h2>Choice filling is a one-shot decision. Go in with the numbers.</h2>
    <button class="btn btn-primary btn-lg" id="to-signup">Sign up free ${icon.arrowR}</button>
  </div></section>`;
  mountAuth($('#home-auth-body'), {
    mode: 'signup',
    onMode: m => {
      $('#ha-eye').textContent = { signup: 'Free sign-up', reset: 'Forgot password' }[m] || 'Welcome back';
      $('#ha-title').textContent = { signup: 'Create your account', reset: 'Reset your password' }[m] || 'Sign in';
    }
  });
  $('#to-signup').onclick = () => {
    $('#home-auth').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    $('#home-auth input')?.focus({ preventScroll: true });
  };
  coverageMap($('#coverage'));
}

// =====================================================================
// Seat matrix: every PG broad speciality seat in India (NMC), with filters and analysis
// =====================================================================
const SM_TYPES = ['Government', 'Private', 'Deemed'];
async function viewSeats() {
  view.innerHTML = `<div class="sm">
    <div class="page-head"><div><div class="eyebrow">All states and union territories</div><h1>PG seat matrix of India 2026–27</h1>
      <p id="sm-lede">Every MD, MS and diploma seat NMC has approved, college by college. Filter by state, college type and course; the totals and charts follow your filters.</p></div></div>
    <div id="sm-body"><div class="rp-wait"><span class="spinner"></span></div></div></div>`;
  let D;
  try { D = S.nmcSeats ||= await api('/api/seat-matrix'); }
  catch (e) { $('#sm-body').innerHTML = `<div class="empty"><h3>We couldn't load the seat matrix</h3><p>${esc(e.message)}</p></div>`; return; }
  if (S.path !== '/seats') return;
  const rows = D.rows.map(([c, k, seats, dip]) => {
    const [code, college, state, type] = D.colleges[c];
    return { code, college, state, type, course: D.courses[k], programme: dip ? 'Diploma' : 'MD/MS', seats };
  });
  $('#sm-lede').insertAdjacentHTML('beforeend', ` <span class="muted">Source: ${esc(D.source)}. ${esc(D.note)}</span>`);
  const host = $('#sm-body');
  const sum = v => v.reduce((n, r) => n + r.seats, 0);
  const x = explorer(host, {
    rows,
    prog: { of: r => r.programme, all: true, value: '' },
    selects: [{ id: 'state', label: 'State / UT', all: 'All states and UTs', of: r => r.state },
      { id: 'type', label: 'College type', all: 'Government, private and deemed', of: r => r.type },
      { id: 'course', label: 'Course', all: 'All courses', of: r => r.course }],
    search: { placeholder: 'College, city or course (e.g. Manipal, Pune, Radio-Diagnosis)', of: r => `${r.college} ${r.course} ${r.state}` },
    order: v => [...v].sort((a, b) => a.state.localeCompare(b.state) || a.college.localeCompare(b.college) || a.course.localeCompare(b.course)),
    cols: [
      { t: 'Institution', cls: 'strong wrapcell', r: r => `${esc(r.college)}<span class="sub">${esc(r.state)} · ${esc(r.code)}</span>` },
      { t: 'Type', r: r => `<span class="sm-dot sm-t${SM_TYPES.indexOf(r.type) + 1}" aria-hidden="true"></span>${esc(r.type)}` },
      { t: 'Course', cls: 'wrapcell', r: r => `${esc(r.course)}<span class="sub">${esc(r.programme)}</span>` },
      { t: 'Seats', cls: 'n r strong', r: r => fmt(r.seats) }
    ],
    summary: v => { smCharts(v); return `<b>${fmt(sum(v))}</b> seats in <b>${fmt(new Set(v.map(r => r.college)).size)}</b> institutions · ${fmt(v.length)} college courses`; },
    csv: { name: 'pg-seat-matrix-india-2026.csv', head: ['State/UT', 'College code', 'Institution', 'Type', 'Programme', 'Course', 'Seats'],
      row: r => [r.state, r.code, r.college, r.type, r.programme, r.course, r.seats] }
  });
  // the analysis sits between the filters and the table, and follows them
  host.querySelector('.rp-filters').insertAdjacentHTML('afterend', `<section class="sm-viz" aria-label="Analysis">
    <div class="sm-kpis" id="sm-kpis"></div>
    <div class="sm-charts"><figure class="sm-card"><figcaption id="sm-c1t"></figcaption><div class="sm-legend">${SM_TYPES.map((t, i) =>
      `<span><i class="sm-t${i + 1}"></i>${t}</span>`).join('')}</div><div class="sm-bars" id="sm-c1"></div></figure>
      <figure class="sm-card"><figcaption id="sm-c2t"></figcaption><div class="sm-bars" id="sm-c2"></div></figure></div>
    <div class="sm-tip" id="sm-tip" role="tooltip" hidden></div></section>`);
  x.refresh();
  // clicking a state's bar filters the table to that state
  $('#sm-c1').addEventListener('click', e => {
    const b = e.target.closest('[data-state]');
    if (!b) return;
    const sel = host.querySelector('[data-x="state"]');
    sel.value = b.dataset.state; sel.dispatchEvent(new Event('change'));
  });
  addEventListener('resize', () => { const t = $('#sm-tip'); if (t) t.hidden = true; });
  for (const id of ['#sm-c1', '#sm-c2']) {
    const box = $(id), tip = $('#sm-tip');
    const show = (row, ev) => {
      if (!row) { tip.hidden = true; return; }
      tip.innerHTML = row.dataset.tip; tip.hidden = false;
      const r = (ev?.type === 'focusin' ? row : null)?.getBoundingClientRect(), host2 = $('.sm-viz').getBoundingClientRect();
      const x0 = (ev?.clientX ?? r.left + 40) - host2.left, y0 = (ev?.clientY ?? r.top) - host2.top;
      tip.style.left = Math.max(0, Math.min(x0 + 14, host2.width - tip.offsetWidth - 4)) + 'px'; tip.style.top = (y0 + 16) + 'px';
    };
    box.addEventListener('mousemove', e => show(e.target.closest('.sm-row'), e));
    box.addEventListener('mouseleave', () => show(null));
    box.addEventListener('focusin', e => show(e.target.closest('.sm-row'), e));
    box.addEventListener('focusout', () => show(null));
  }
}
function smCharts(v) {
  if (!$('#sm-kpis')) return;
  const sum = list => list.reduce((n, r) => n + r.seats, 0), total = sum(v);
  const byType = SM_TYPES.map(t => sum(v.filter(r => r.type === t)));
  const pct = n => total ? Math.round(100 * n / total) + '%' : '—';
  $('#sm-kpis').innerHTML = [[fmt(total), 'PG seats'], [fmt(new Set(v.map(r => r.college)).size), 'institutions'], [fmt(new Set(v.map(r => r.course)).size), 'courses'],
    [fmt(new Set(v.map(r => r.state)).size), 'states and UTs']].map(([n, t]) => `<div><b>${n}</b><span>${t}</span></div>`).join('')
    + `<div class="sm-split"><span>${SM_TYPES.map((t, i) => `<i class="sm-t${i + 1}" style="flex:${byType[i]}"></i>`).join('')}</span>
      <small>${SM_TYPES.map((t, i) => `${t} ${pct(byType[i])}`).join(' · ')}</small></div>`;
  // chart 1: by state (or, within one state, by institution), stacked by college type
  const states = new Set(v.map(r => r.state));
  const one = states.size === 1, key = one ? 'college' : 'state';
  const groups = new Map();
  for (const r of v) { const g = groups.get(r[key]) || groups.set(r[key], [0, 0, 0]).get(r[key]); g[SM_TYPES.indexOf(r.type)] += r.seats; }
  let list = [...groups].map(([name, t]) => ({ name, t, n: t[0] + t[1] + t[2] })).sort((a, b) => b.n - a.n);
  const cap = one ? 15 : 40, more = list.length - cap;
  list = list.slice(0, cap);
  const max = Math.max(1, ...list.map(g => g.n));
  $('#sm-c1t').innerHTML = one ? `Seats by institution in ${esc([...states][0])}${more > 0 ? ` <small>top ${cap} of ${cap + more}</small>` : ''}`
    : `Seats by state and UT <small>click a state to filter</small>`;
  $('#sm-c1').innerHTML = list.map(g => `<div class="sm-row" tabindex="0"${one ? '' : ` data-state="${esc(g.name)}" role="button"`} aria-label="${esc(g.name)}: ${fmt(g.n)} seats"
      data-tip="${esc(`<b>${esc(g.name)}</b>${SM_TYPES.map((t, i) => g.t[i] ? `<span><i class="sm-t${i + 1}"></i>${t} <b>${fmt(g.t[i])}</b></span>` : '').join('')}<span>Total <b>${fmt(g.n)}</b></span>`)}">
      <span class="sm-lab">${esc(g.name)}</span><span class="sm-track"><span class="sm-bar" style="width:${100 * g.n / max}%">${g.t.map((n, i) => n ? `<i class="sm-t${i + 1}" style="flex:${n}"></i>` : '').join('')}</span></span>
      <span class="sm-val">${fmt(g.n)}</span></div>`).join('') || '<p class="muted">No seats match these filters.</p>';
  // chart 2: the courses with the most seats
  const cs = new Map();
  for (const r of v) cs.set(r.course, (cs.get(r.course) || 0) + r.seats);
  const top = [...cs].sort((a, b) => b[1] - a[1]).slice(0, 12), cmax = Math.max(1, ...top.map(c => c[1]));
  $('#sm-c2t').innerHTML = `Courses with the most seats${cs.size > 12 ? ` <small>top 12 of ${cs.size}</small>` : ''}`;
  $('#sm-c2').innerHTML = top.map(([c, n]) => `<div class="sm-row" tabindex="0" aria-label="${esc(c)}: ${fmt(n)} seats"
      data-tip="${esc(`<b>${esc(c)}</b><span>${fmt(n)} seats · ${pct(n)} of the seats shown</span>`)}">
      <span class="sm-lab">${esc(c.replace(/^M\.[DS]\.\s*/, ''))}</span><span class="sm-track"><span class="sm-bar sm-one" style="width:${100 * n / cmax}%"><i></i></span></span>
      <span class="sm-val">${fmt(n)}</span></div>`).join('') || '<p class="muted">No seats match these filters.</p>';
}

function viewMethod() {
  const sets = S.cfg.datasets || [];
  view.innerHTML = `<div class="doc">
    <nav class="toc" aria-label="On this page">
      <a href="#sources">Sources</a><a href="#ranks">CMR and AIR</a><a href="#chance">The chance grade</a>
      <a href="#rounds">Rounds</a><a href="#limits">Limits</a><a href="#data">Datasets</a>
    </nav>
    <article class="prose">
      <div class="eyebrow">Method &amp; sources</div>
      <h1>How RankRound reads the numbers</h1>
      <p class="lede">Every figure is history, not a forecast. It shows which ranks were admitted to each seat last year,
        so you can judge where your own rank sits.</p>

      <h2 id="sources">Sources</h2>
      <p><b>Odisha state counselling</b> comes from the Odisha state counselling result — every admission across all rounds, including the
        stray round. It is the only source that records the <b>direct and in-service</b> split and the round each seat went in.</p>
      <p><b>Gujarat state counselling</b> comes from ACPPGMEC's <i>Institutewise Last Rank</i> sheets for PG-2025 and PG-2024. They list,
        for every college, branch, quota (Government, University, Management, NRI, In-service) and category, the <b>last candidate
        admitted in the final round</b>: their state merit number (used here as the CMR) and NEET All India Rank. Opening ranks and seat
        counts are not published, and seats converted to another quota are left out. Earlier rounds closed tighter than these figures.</p>
      <p><b>All India Quota</b> comes from the national postgraduate admission list, filtered to Odisha colleges and to the All India Quota.
        These seats are filled by the MCC on NEET All India Rank; candidates come from every state and the Odisha merit number plays no part.</p>
      <p>The two are separate pools ranked on different numbers. <b>Their cut-offs cannot be compared with one another.</b></p>

      <h2 id="ranks">CMR and AIR</h2>
      <p><b>CMR</b> is the Odisha combined merit rank, and it is what state counselling runs on. Odisha keeps separate merit lists for
        direct and in-service candidates, so the CMR restarts at 1 in each stream — an in-service CMR and a direct CMR are not the same number.</p>
      <p>The NEET All India Rank is shown for state seats where the merit list published it. Where it is missing, the range reads “—”,
        and the detail view says how many of the admitted candidates had an AIR listed.</p>

      <h2 id="chance">The chance grade</h2>
      <p>For each seat we take the opening (best) and closing (worst) rank admitted within the category. Your rank is then graded:</p>
      <div class="band-key" style="margin:18px 0">
        ${[[4, 'Better than or equal to the opening rank.'], [3, 'Up to the midpoint of the range.'], [2, 'From the midpoint to the closing rank.'], [1, 'Up to 15% past the closing rank.']]
          .map(([b, t]) => `<div>${bandHtml(b)}<p>${t}</p></div>`).join('')}
      </div>
      <p>Where only the last admitted rank is published (Gujarat), there is no range to place your rank in, so the grade is how far
        inside that closing rank you are: <b>Very high</b> 20% or more inside, <b>High</b> 10–20% inside, <b>Moderate</b> within 10%,
        <b>Low</b> up to 15% past it.</p>
      <p>Seats more than 15% past their closing rank are left out. The <b>margin</b> column is the closing rank minus yours: positive means
        you were inside the cut-off by that many ranks.</p>
      <p>When you choose a reserved category, unreserved (UR, or OPEN in Gujarat) or General seats are included by default, because reserved-category
        candidates also compete for open seats on merit. You can switch this off.</p>

      <h2 id="rounds">Rounds</h2>
      <p>R-1 to R-4 are the counselling rounds each seat was taken in; UGR-1 is the upgradation round; R-? means the round was not recorded.
        A seat that only went in a late round usually closes at a much worse rank than the same seat in round 1.</p>

      <h2 id="limits">Limits</h2>
      <p>A seat that took one student is a thin sample. Cut-offs move with seat additions and withdrawals, paper difficulty,
        reservation rules, candidate numbers and round-by-round vacancies — none of which are modelled here. College, speciality and branch
        names that appeared under several spellings have been merged, and category codes expanded into words.</p>
      <p>Always verify against the official counselling bulletin before locking a preference.</p>

      <h2 id="data">Datasets</h2>
      <div class="grid-wrap"><table class="grid">
        <thead><tr><th>Dataset</th><th>Year</th><th class="r">Seat groups</th><th class="r">Admissions</th><th class="r">Colleges</th></tr></thead>
        <tbody>${sets.map(d => `<tr><td class="strong">${esc(d.label)}</td><td class="nowrap">${d.year}</td>
          <td class="n">${fmt(d.rows)}</td><td class="n">${fmt(d.seats)}</td><td class="n">${fmt(d.colleges)}</td></tr>`).join('')}</tbody>
      </table></div>
    </article>
  </div>`;
}

boot();
