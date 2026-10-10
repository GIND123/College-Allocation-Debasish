import {
  esc, fmt, debounce, $, $$, uniq, store, api, track, toast, openDialog, openDrawer, downloadCsv, icon, toggleTheme
} from './lib.js';

const STEP = 150;
const FIREBASE_SDK = '10.12.2';
const BAND = { 4: 'Very high', 3: 'High', 2: 'Moderate', 1: 'Low' };
const KIND = {
  state: {
    label: 'State counselling', rank: 'CMR', spec: 'speciality', specLabel: 'Speciality',
    open: 'cmr_open', close: 'cmr_close', openCat: 'UR', filters: ['stream', 'category', 'programme', 'speciality', 'college'],
    get rankLong() { return `${myState()} CMR`; },
    get note() { return `Ranked by the ${myState()} combined merit rank (CMR). Direct and in-service candidates are on separate merit lists.`; }
  },
  aiq: {
    label: 'All India Quota', rank: 'AIR', rankLong: 'NEET All India Rank', spec: 'branch', specLabel: 'Branch',
    open: 'open_rank', close: 'close_rank', openCat: 'GENERAL', filters: ['category', 'type', 'branch', 'college'],
    get note() { return `Seats in ${myState()} colleges filled by the MCC on NEET All India Rank — a national pool, separate from state counselling.`; }
  }
};
const myState = () => S.user?.state || 'State';
const profileComplete = () => !!(S.user?.name && S.user?.cmr && S.user?.state);
const FILTER_LABEL = { stream: 'Stream', category: 'Category', programme: 'Programme', speciality: 'Speciality', branch: 'Branch', college: 'College', type: 'College type' };
const ALL_LABEL = { category: 'All categories', programme: 'All programmes', speciality: 'All specialities', branch: 'All branches', college: 'All colleges', type: 'Government & private' };

/** Same thresholds as the original tool: lower rank is better. */
function band(rank, open, close) {
  if (rank <= open) return 4;
  if (rank <= open + (close - open) * 0.5) return 3;
  if (rank <= close) return 2;
  if (rank <= close * 1.15) return 1;
  return 0;
}
// Must match rowKey() in server/index.js — it identifies a shortlisted seat.
const rowKey = (kind, r) => kind === 'state'
  ? [r.college, r.speciality, r.programme, r.stream, r.category].join(' | ')
  : [r.college, r.branch, r.category].join(' | ') + ' | ' + r.type;
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
  state: { rank: '', stream: 'Direct', category: '', withOpen: true, programme: '', speciality: '', college: '', q: '' },
  aiq: { rank: '', category: '', withOpen: true, type: '', branch: '', college: '', q: '' }
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

const ROUTES = { '/': viewHome, '/predict': () => viewWork('predict'), '/cutoffs': () => viewWork('cutoffs'), '/shortlist': viewShortlist, '/method': viewMethod };
const GATED = new Set(['/predict', '/cutoffs', '/shortlist']);

function go(path) { history.pushState({}, '', path); route(); }
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.origin !== location.origin) return;
  e.preventDefault();
  go(a.pathname);
});
addEventListener('popstate', () => { if (location.pathname !== S.path) route(); });

async function route() {
  let p = ROUTES[location.pathname] ? location.pathname : '/';
  if (p === '/' && S.user) { history.replaceState({}, '', '/predict'); p = '/predict'; }
  const changed = p !== S.path;
  S.path = p;
  $$('#nav a').forEach(a => a.pathname === p ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  $('#nav').hidden = !S.user;
  document.body.classList.toggle('has-nav', !!S.user);
  if (GATED.has(p) && !S.user) viewGate(p);
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
      ${S.user.state ? `<span>${esc(S.user.state)}${S.user.cmr ? ` · CMR ${fmt(S.user.cmr)}` : ''}</span>` : ''}</div>
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
    S.user = null; S.shortlist = []; S.cache.clear();
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
// Profile: name, NEET-PG CMR and state (the state decides which data shows)
// =====================================================================
function stateOptions(sel) {
  const have = S.cfg.dataStates || [];
  const opt = s => `<option ${s === sel ? 'selected' : ''}>${esc(s)}</option>`;
  const rest = S.cfg.states.filter(s => !have.includes(s));
  return `<option value="">Choose your state</option>` + (have.length
    ? `<optgroup label="Cut-off data available">${have.map(opt).join('')}</optgroup><optgroup label="All states and UTs">${rest.map(opt).join('')}</optgroup>`
    : rest.map(opt).join(''));
}
const cmrField = v => `<label class="field"><span class="label">NEET-PG CMR</span>
  <input class="input num" name="cmr" inputmode="numeric" autocomplete="off" placeholder="e.g. 250" value="${esc(v ?? '')}" maxlength="7" required></label>`;
const stateField = v => `<label class="field"><span class="label">State</span><select class="select" name="state" required>${stateOptions(v)}</select></label>`;

/** The CMR given at sign-up is the starting rank for state counselling. */
function applyProfile(force = false) {
  if (S.user?.cmr && (force || !S.f.state.rank)) { S.f.state.rank = String(S.user.cmr); saveFilters(); }
}

function profileForm(host, { onSaved, onCancel }) {
  const u = S.user;
  const draw = err => {
    host.innerHTML = `<form class="auth" novalidate>
      <label class="field"><span class="label">Full name</span><input class="input" name="name" autocomplete="name" value="${esc(u.name)}" maxlength="80" required></label>
      <div class="auth-pair">${cmrField(u.cmr)}${stateField(u.state)}</div>
      ${err ? `<div class="alert alert-err form-err" role="alert">${esc(err)}</div>` : ''}
      <div class="auth-actions">${onCancel ? '<button type="button" class="btn btn-line" data-cancel>Cancel</button>' : ''}
        <button class="btn btn-primary">Save and continue</button></div>
    </form>`;
    const f = host.querySelector('form'), el = n => f.elements.namedItem(n);
    if (onCancel) f.querySelector('[data-cancel]').onclick = onCancel;
    f.onsubmit = async e => {
      e.preventDefault();
      const body = { name: el('name').value.trim(), cmr: el('cmr').value.replace(/\D/g, ''), state: el('state').value };
      if (body.name.length < 2) return draw('Enter your full name.');
      if (!body.cmr) return draw('Enter your NEET-PG CMR.');
      if (!body.state) return draw('Choose your state.');
      try {
        const prev = S.user;
        S.user = (await api('/api/me', { method: 'PATCH', body })).user;
        if (prev.state !== S.user.state) {
          // Another state's data: start from clean filters and its datasets.
          S.f = freshFilters(); S.dsId = { state: null, aiq: null };
          S.cfg = await api('/api/config').catch(() => S.cfg);
        }
        applyProfile(prev.cmr !== S.user.cmr || prev.state !== S.user.state);
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
    <p>We show cut-offs for the state you choose. Add your NEET-PG CMR and state to continue.</p>
    <div class="auth-card" id="pf"></div>
  </div>`;
  profileForm($('#pf'), { onSaved: () => { toast('Profile saved.'); route(); } });
}

// =====================================================================
// Sign-up / sign-in: mobile or email + one-time code (mock now; Firebase SMS
// and email codes when configured on the server)
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

/** Renders the sign-up / sign-in flow into `host`. Returns a cleanup function. */
function mountAuth(host, { mode = 'signup', autofocus = false, onMode, onDone } = {}) {
  const provider = S.cfg.auth.provider, len = S.cfg.auth.otpLength || 4, emailOk = S.cfg.auth.email;
  const a = { mode, channel: 'phone', name: '', phone: '', email: '', cmr: '', state: '' };
  let confirmation = null, verifier = null, timer = null, opened = false;
  const viaFirebase = () => provider === 'firebase' && a.channel === 'phone';
  const shown = () => a.channel === 'email' ? a.email : '+91 ' + a.phone.replace(/(\d{5})(\d{5})/, '$1 $2');
  const profile = () => a.mode === 'signup' ? { name: a.name, cmr: a.cmr, state: a.state } : {};
  host.addEventListener('focusin', () => { if (!opened) { opened = true; track('signin_open'); } });

  function form(err) {
    clearInterval(timer);
    onMode?.(a.mode);
    const up = a.mode === 'signup';
    host.innerHTML = `
      <form class="auth" novalidate>
        ${up ? `<label class="field"><span class="label">Full name</span>
          <input class="input" name="name" autocomplete="name" value="${esc(a.name)}" maxlength="80" required></label>` : ''}
        <div class="field"><span class="label">${emailOk ? 'Mobile or email' : 'Mobile number'} <span class="hint">for a one-time code</span></span>
          ${emailOk ? `<div class="seg auth-ch" role="group" aria-label="Get the code by">
            <button type="button" data-ch="phone" aria-pressed="${a.channel === 'phone'}">Mobile</button>
            <button type="button" data-ch="email" aria-pressed="${a.channel === 'email'}">Email</button></div>` : ''}
          ${a.channel === 'email'
            ? `<input class="input" name="email" type="email" autocomplete="email" placeholder="you@example.com" value="${esc(a.email)}" maxlength="254" aria-label="Email address" required>`
            : `<div class="phone"><span>+91</span><input class="input" name="phone" inputmode="numeric" autocomplete="tel-national"
                placeholder="98765 43210" value="${esc(a.phone)}" maxlength="14" aria-label="Mobile number" required></div>`}
        </div>
        ${up ? `<div class="auth-pair">${cmrField(a.cmr)}${stateField(a.state)}</div>` : ''}
        ${err ? `<div class="alert alert-err form-err" role="alert">${esc(err)}</div>` : ''}
        <button class="btn btn-primary btn-lg auth-go" id="send">${up ? 'Sign up' : 'Send code'} ${icon.arrowR}</button>
        <div id="recaptcha-box"></div>
        <p class="auth-switch">${up
          ? 'Already registered? <button type="button" class="linkbtn" data-mode="signin">Sign in</button>'
          : 'New here? <button type="button" class="linkbtn" data-mode="signup">Create an account</button>'}</p>
        ${up ? `<p class="fine">You'll see cut-offs for the state you choose. By signing up you agree that a counsellor may contact you about PG admissions.</p>` : ''}
      </form>`;
    const f = host.querySelector('form'), el = n => f.elements.namedItem(n);
    if (autofocus) f.querySelector('input').focus();
    f.oninput = e => { if (e.target.name in a) a[e.target.name] = e.target.value; };
    $$('[data-ch]', f).forEach(b => b.onclick = () => { a.channel = b.dataset.ch; form(); host.querySelector(`[name="${a.channel}"]`).focus(); });
    $$('[data-mode]', f).forEach(b => b.onclick = () => { a.mode = b.dataset.mode; form(); host.querySelector('input').focus(); });
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
      if (up) {
        a.cmr = el('cmr').value.replace(/\D/g, '');
        a.state = el('state').value;
        if (!(+a.cmr > 0)) return form('Enter your NEET-PG CMR — your rank on the state merit list.');
        if (!a.state) return form('Choose your state.');
      }
      const btn = f.querySelector('#send');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Sending code';
      try {
        if (viaFirebase()) {
          const { auth, mod } = await firebase();
          verifier?.clear?.();
          verifier = new mod.RecaptchaVerifier(auth, 'recaptcha-box', { size: 'invisible' });
          confirmation = await mod.signInWithPhoneNumber(auth, '+91' + a.phone, verifier);
        } else {
          await api('/api/auth/otp/request', { method: 'POST', body: { mode: a.mode, channel: a.channel, phone: a.phone, email: a.email, ...profile() } });
        }
        code();
      } catch (err) {
        form(firebaseMessage(err) || err.message);
      }
    };
  }

  function code(err) {
    clearInterval(timer);
    host.innerHTML = `
      <p class="signin-lead">Enter the ${len}-digit code sent to <b class="num">${esc(shown())}</b>.
        <button class="linkbtn" id="chg">Change</button></p>
      ${provider === 'mock' ? `<div class="alert alert-info" style="margin-bottom:18px">Test mode — no SMS or email is sent. Use code <b class="num">1234</b>.</div>` : ''}
      <form id="s2">
        <div class="otp ${len > 4 ? 'six' : ''}" role="group" aria-label="One-time code">
          ${Array.from({ length: len }, (_, i) => `<input inputmode="numeric" maxlength="1" autocomplete="${i ? 'off' : 'one-time-code'}" aria-label="Digit ${i + 1}">`).join('')}
        </div>
        ${err ? `<div class="alert alert-err form-err">${esc(err)}</div>` : ''}
        <button class="btn btn-primary btn-lg auth-go" id="verify">Verify and continue</button>
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
        let r;
        if (viaFirebase()) {
          const cred = await confirmation.confirm(c);
          const idToken = await cred.user.getIdToken();
          r = await api('/api/auth/firebase', { method: 'POST', body: { idToken, mode: a.mode, ...profile() } });
          fb.mod.signOut(fb.auth).catch(() => {});
        } else {
          r = await api('/api/auth/otp/verify', { method: 'POST', body: { channel: a.channel, phone: a.phone, email: a.email, code: c } });
        }
        clearInterval(timer);
        onDone?.();
        await signedIn(r.user, r.isNew);
      } catch (err) {
        code(firebaseMessage(err) || err.message);
      }
    };
  }
  form();
  return () => { clearInterval(timer); verifier?.clear?.(); };
}

function openSignIn(then, mode = 'signin') {
  if (then) S.intended = then;
  let stop;
  const d = openDialog(`
    <div class="dialog-head"><h2 id="si-title"></h2><button class="icon-btn" data-close aria-label="Close">${icon.x}</button></div>
    <div class="dialog-body" id="si"></div>`, { onClose: () => stop?.() });
  stop = mountAuth(d.el.querySelector('#si'), {
    mode, autofocus: true, onDone: () => d.close(),
    onMode: m => { d.el.querySelector('#si-title').textContent = m === 'signup' ? 'Create your free account' : 'Sign in to RankRound'; }
  });
}
function firebaseMessage(err) {
  const c = err?.code || '';
  if (!c.startsWith('auth/')) return '';
  return {
    'auth/invalid-verification-code': 'Incorrect code. Check the SMS and try again.',
    'auth/code-expired': 'That code has expired. Request a new one.',
    'auth/too-many-requests': 'Too many attempts from this device. Try again later.',
    'auth/invalid-phone-number': 'Enter a valid 10-digit Indian mobile number.',
    'auth/quota-exceeded': 'SMS limit reached for today. Please try again later.'
  }[c] || 'Sign-in failed. Please try again.';
}
async function signedIn(user, isNew) {
  S.user = user;
  S.cfg = await api('/api/config').catch(() => S.cfg);
  S.dsId = { state: null, aiq: null };
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
    for (const o of rows) o._k = rowKey(kind, o);
    S.cache.set(id, { dataset: r.dataset, rows });
  }
  return S.cache.get(id);
}

function matches(kind, r, f, except) {
  for (const k of KIND[kind].filters) {
    if (k === except) continue;
    const v = f[k];
    if (!v) continue;
    if (k === 'category') {
      if (r.category !== v && !(f.withOpen && r.category === KIND[kind].openCat)) return false;
    } else if (r[k] !== v) return false;
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
    <p class="ctx-note">${esc(KIND[kind].note)}</p>
  </div></div>`;
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

async function viewWork(mode) {
  const kind = S.scope;
  S.mode = mode;
  S.shown = STEP;
  view.innerHTML = ctxbar(kind) + `
    <div class="workspace">
      <aside class="rail" id="rail" aria-label="Filters"></aside>
      <section class="results" id="res"><div class="empty"><span class="spinner"></span></div></section>
    </div>`;
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
    const have = S.cfg.dataStates || [];
    const wa = waLink(`Hi, I would like help with ${myState()} PG counselling.`);
    $('#res').innerHTML = `<div class="empty">
      <h3>${esc(myState())} ${kind === 'state' ? 'state counselling' : 'All India Quota'} data is coming soon</h3>
      <p>We're adding states one at a time${have.length ? ` — cut-offs are live for ${esc(have.join(', '))}` : ''}.
        Your sign-up is saved, and ${esc(myState())} data will appear here as soon as it is published.</p>
      <div class="empty-actions"><a class="btn btn-line" href="/counselling">2026 counselling guide</a>
        <button class="btn btn-line" id="chg-state">Change state</button>
        ${wa ? `<a class="btn btn-primary" href="${esc(wa)}" target="_blank" rel="noopener">${icon.chat} Talk to a counsellor</a>` : ''}</div>
    </div>`;
    $('#chg-state').onclick = editProfile;
    return;
  }
  S.data = data;
  renderRail();
  renderResults();
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
      ` : `
        <label class="label" for="f-q">Search</label>
        <div class="search-wrap">${icon.search}<input class="input" id="f-q" type="search" autocomplete="off" placeholder="College, speciality, category" value="${esc(f.q)}"></div>
      `}
      ${kind === 'state' ? `
        <div class="field" style="margin-top:16px"><span class="label">Stream</span>
          <div class="seg" role="group" aria-label="Stream">
            ${STREAMS.map(([v, t]) =>
              `<button data-stream="${v}" aria-pressed="${f.stream === v}">${t}</button>`).join('')}
          </div>
        </div>
        <p class="note">Direct and in-service candidates have <b>separate merit lists</b> — the CMR restarts at 1 in each. Compare only within your stream.</p>
      ` : ''}
    </div>
    <button class="rail-toggle" id="rtog" aria-expanded="${!collapsed}">More filters <span id="rsum">${esc(railSummary(kind))}</span></button>
    <div class="rail-sec fold">
      <div class="rail-title"><h3>Refine</h3><button class="linkbtn" id="f-reset">Reset all</button></div>
      <label class="field"><span class="label">Category</span><select class="select" data-f="category">${selectHtml(kind, 'category')}</select></label>
      <label class="check" id="wopen" ${f.category && f.category !== K.openCat ? '' : 'hidden'}>
        <input type="checkbox" id="f-open" ${f.withOpen ? 'checked' : ''}>
        <span>Also show ${K.openCat === 'UR' ? 'unreserved (UR)' : 'General'} seats — reserved-category candidates compete for these on merit too.</span>
      </label>
      ${K.filters.filter(k => !['stream', 'category'].includes(k)).map(k => `
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
  $$('[data-stream]').forEach(b => b.onclick = () => {
    f.stream = b.dataset.stream;
    $$('[data-stream]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    changed();
  });
  $$('select[data-f]', rail).forEach(s => s.onchange = () => {
    f[s.dataset.f] = s.value;
    if (s.dataset.f === 'category') $('#wopen').hidden = !(s.value && s.value !== K.openCat);
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
    r: r => `<span title="${esc(r.college)}">${esc(shortCollege(r.college))}</span>` + (kind === 'aiq' ? `<span class="sub">${esc(r.type)}</span>` : '') });
  c.push({ id: 'spec', t: K.specLabel, v: r => r[K.spec], cls: 'wrapcell',
    r: r => esc(r[K.spec]) + (kind === 'state' ? `<span class="sub">${esc(r.programme)} · ${esc(r.rounds || 'R-?')}</span>` : '') });
  c.push({ id: 'category', t: 'Category', v: r => r.category + (r.stream || ''), cls: 'nowrap',
    r: r => esc(r.category) + (kind === 'state' ? `<span class="sub">${esc(r.stream)}</span>` : '') });
  const p = mode === 'predict';
  c.push({ id: 'open', t: p ? 'Open' : `${K.rank} open`, v: r => r[K.open], num: true, cls: 'n soft', r: r => fmt(r[K.open]) });
  c.push({ id: 'close', t: p ? 'Close' : `${K.rank} close`, v: r => r[K.close], num: true, cls: 'n',
    r: r => fmt(r[K.close]) + (p ? `<span class="sub">${r.seats} seat${r.seats === 1 ? '' : 's'}</span>` : '') });
  if (mode === 'predict') {
    c.push({ id: 'margin', t: 'Margin', v: r => r._m, num: true, cls: 'n',
      r: r => `<span class="${r._m >= 0 ? 'margin-pos' : 'margin-neg'}" title="${r._m >= 0 ? 'ranks inside' : 'ranks past'} the closing rank">${r._m >= 0 ? '+' : '−'}${fmt(Math.abs(r._m))}</span>` });
    c.push({ id: 'pos', t: 'Position', cls: 'pos nowrap', r: r => posSvg(r[K.open], r[K.close], rank) });
    return c;
  }
  if (kind === 'state') c.push({ id: 'air', t: 'NEET AIR', v: r => r.air_close, num: true, cls: 'n soft',
    r: r => r.air_open ? (r.air_open === r.air_close ? fmt(r.air_open) : `${fmt(r.air_open)}–${fmt(r.air_close)}`) : '—' });
  c.push({ id: 'seats', t: 'Seats', v: r => r.seats, num: true, cls: 'n soft', r: r => fmt(r.seats) });
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
          ? `Your CMR is the rank on the ${esc(myState())} state merit list — not your NEET All India Rank. Pick your stream (direct or in-service) first: the two lists are numbered separately.`
          : 'All India Quota seats are allotted by the MCC on your NEET All India Rank. Candidates from every state compete for these seats.'}</p>
      </div>`;
    return;
  }

  let list = S.data.rows.filter(r => matches(kind, r, f) && (mode !== 'cutoffs' || searchHit(r, f.q)));
  const tally = { 4: 0, 3: 0, 2: 0, 1: 0 };
  if (mode === 'predict') {
    list = list.filter(r => {
      r._b = band(rank, r[K.open], r[K.close]);
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
  const who = [kind === 'state' ? f.stream : '', f.category ? f.category + (f.withOpen && f.category !== K.openCat ? ` + ${K.openCat}` : '') : 'all categories']
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
    <div class="grid-wrap"><div class="empty"><h3>${mode === 'predict' ? 'No seats in reach with these filters' : 'Nothing matches'}</h3>
      <p>${mode === 'predict' ? `In ${S.data.dataset.year}, no seat in this selection closed at or near ${K.rank} ${fmt(rank)}. Try widening the filters${kind === 'state' ? ' or check your stream' : ''}.` : 'Try a different search or clear some filters.'}</p></div></div>`}`;

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
}
mobile.addEventListener('change', () => { if (S.data && $('#res')) renderResults(); });

function cardHtml(r, i) {
  const kind = S.scope, K = KIND[kind], rank = parseInt(S.f[kind].rank, 10);
  const predict = S.mode === 'predict';
  return `<div class="card" data-i="${i}">
    <div class="card-top">${predict ? bandHtml(r._b) : `<span class="eyebrow">${esc(kind === 'state' ? r.programme : r.type)}</span>`}${starHtml(kind, r)}</div>
    <div class="card-spec">${esc(r[K.spec])}</div>
    <div class="card-coll">${esc(shortCollege(r.college))} · ${esc(r.category)}${kind === 'state' ? ' · ' + esc(r.stream) : ''}</div>
    <div class="card-nums">
      <div><span>${K.rank} close</span><b>${fmt(r[K.close])}</b></div>
      <div><span>Open</span><b>${fmt(r[K.open])}</b></div>
      ${predict ? `<div><span>Margin</span><b>${r._m >= 0 ? '+' : '−'}${fmt(Math.abs(r._m))}</b></div>` : `<div><span>Seats</span><b>${fmt(r.seats)}</b></div>`}
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
function rangeChart(open, close, rank, unit) {
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
    <span style="display:inline-flex;align-items:center;gap:6px"><i style="width:10px;height:10px;background:var(--ink-2);opacity:.6"></i>2025 opening–closing</span>
    <span style="display:inline-flex;align-items:center;gap:6px"><i style="width:10px;height:10px;background:var(--b1);opacity:.35"></i>Stretch zone (+15%)</span>
    ${rank ? `<span style="display:inline-flex;align-items:center;gap:6px"><i style="width:2px;height:10px;background:var(--brass)"></i>Your rank</span>` : ''}
  </div>`;
}

let drawer = null;
function openSeat(kind, r) {
  const K = KIND[kind], f = S.f[kind];
  const rank = S.mode === 'predict' ? parseInt(f.rank, 10) || null : (parseInt(f.rank, 10) || null);
  const b = rank ? band(rank, r[K.open], r[K.close]) : null;
  const spec = r[K.spec];
  track('seat_view', { scope: kind, college: r.college, spec, category: r.category });

  const peers = S.data.rows.filter(o => o[K.spec] === spec && o.category === r.category && (kind === 'aiq' || o.stream === r.stream))
    .sort((a, c) => a[K.close] - c[K.close]);
  const here = S.data.rows.filter(o => o.college === r.college && o[K.spec] === spec && o !== r)
    .sort((a, c) => (a.stream || '').localeCompare(c.stream || '') || a[K.close] - c[K.close]);
  const on = !!slItem(kind, r._k);
  const margin = rank ? r[K.close] - rank : 0;
  const verdict = !rank ? '' : b
    ? `${margin >= 0 ? `${fmt(margin)} ranks inside` : `${fmt(-margin)} ranks past`} the ${S.data.dataset.year} closing rank of ${fmt(r[K.close])}.`
    : `Your ${K.rank} is more than 15% past the ${S.data.dataset.year} closing rank of ${fmt(r[K.close])}.`;
  const wa = waLink(`Hi, I'd like advice on ${spec} at ${r.college} (${kind === 'state' ? r.stream + ', ' : ''}${r.category}). My ${K.rank} is ${rank || '—'}.`);

  drawer?.close();
  drawer = openDrawer(`
    <div class="dr-head">
      <div class="eyebrow">${esc(K.label)} · ${esc(S.data.dataset.year)}</div>
      <button class="icon-btn" data-close aria-label="Close">${icon.x}</button>
      <h2>${esc(spec)}</h2>
      <p>${esc(r.college)}</p>
      <div class="dr-tags">
        ${kind === 'state' ? `<span class="tag">${esc(r.programme)}</span><span class="tag">${esc(r.stream)}</span>` : `<span class="tag">${esc(r.type)}</span>`}
        <span class="tag tag-solid">${esc(r.category)}</span>
      </div>
    </div>
    <div class="dr-sec">
      <h3>${rank ? 'Your position' : `${S.data.dataset.year} range`}</h3>
      ${rank ? `<div class="verdict" style="margin-bottom:18px">${b ? bandHtml(b) : '<span class="band" style="font-family:var(--serif);font-size:17px;font-weight:600">Out of range</span>'}<p>${esc(verdict)}</p></div>` : ''}
      ${rangeChart(r[K.open], r[K.close], rank, K.rank)}
    </div>
    <div class="dr-sec">
      <h3>${S.data.dataset.year} record</h3>
      <dl class="facts" style="margin:0">
        <div><dt>Opening ${K.rank}</dt><dd>${fmt(r[K.open])}</dd></div>
        <div><dt>Closing ${K.rank}</dt><dd>${fmt(r[K.close])}</dd></div>
        <div><dt>Seats filled</dt><dd>${fmt(r.seats)} ${r.seats === 1 ? '<small>thin sample</small>' : ''}</dd></div>
        ${kind === 'state' ? `
          <div><dt>NEET AIR range</dt><dd>${r.air_open ? (r.air_open === r.air_close ? fmt(r.air_open) : `${fmt(r.air_open)}–${fmt(r.air_close)}`) : '—'}
            ${r.air_open ? `<small>${r.air_seen}/${r.seats} listed</small>` : ''}</dd></div>
          <div style="grid-column:span 2"><dt>Rounds taken</dt><dd style="font-size:15px">${esc(r.rounds || '—')}</dd></div>` : `
          <div><dt>College type</dt><dd style="font-size:15px;font-family:var(--sans)">${esc(r.type)}</dd></div>`}
      </dl>
    </div>
    <div class="dr-sec">
      <h3>${esc(spec)} elsewhere · ${esc(kind === 'state' ? r.stream + ' · ' : '')}${esc(r.category)}</h3>
      <table class="mini">${peers.slice(0, 12).map(o => `
        <tr class="${o === r ? 'here' : ''}"><td>${rank ? `<span class="band b${band(rank, o[K.open], o[K.close])}"><i style="${band(rank, o[K.open], o[K.close]) ? '' : 'background:var(--rule-2)'}"></i></span> ` : ''}
          ${o === r ? esc(shortCollege(o.college)) : `<a href="#" data-peer="${S.data.rows.indexOf(o)}">${esc(shortCollege(o.college))}</a>`}</td>
          <td class="n">${fmt(o[K.close])}</td></tr>`).join('')}
      </table>
      ${peers.length > 12 ? `<p class="muted" style="font-size:12px;margin:10px 0 0">${peers.length - 12} more in the cut-off table.</p>` : ''}
    </div>
    ${here.length ? `<div class="dr-sec">
      <h3>Other ${kind === 'state' ? 'streams and categories' : 'categories'} at this college</h3>
      <table class="mini">${here.map(o => `<tr><td><a href="#" data-peer="${S.data.rows.indexOf(o)}">${esc(kind === 'state' ? o.stream + ' · ' : '')}${esc(o.category)}</a></td>
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
  view.innerHTML = `
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

  $('#sl-print').onclick = () => print();
  $('#sl-csv').onclick = () => {
    const rows = [];
    for (const kind of ['state', 'aiq']) {
      const K = KIND[kind], rank = parseInt(S.f[kind].rank, 10);
      items.filter(i => i.kind === kind).forEach((i, n) => {
        const r = i.row;
        rows.push([n + 1, K.label, r.college, r[K.spec], r.stream || r.type, r.category, r[K.open], r[K.close], rank ? (BAND[band(rank, r[K.open], r[K.close])] || 'Out of range') : '', i.dataset]);
      });
    }
    downloadCsv('rankround-shortlist.csv', ['Preference', 'Counselling', 'College', 'Speciality / branch', 'Stream / type', 'Category', 'Opening rank', 'Closing rank', 'Chance', 'Data'], rows);
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
        const r = i.row, b = rank ? band(rank, r[K.open], r[K.close]) : null;
        return `<tr>
          <td class="ord">${String(n + 1).padStart(2, '0')}</td>
          <td class="strong wrapcell">${esc(shortCollege(r.college))}<span class="sub">${esc(i.dataset)}</span></td>
          <td class="wrapcell">${esc(r[K.spec])}${kind === 'state' ? `<span class="sub">${esc(r.programme)}</span>` : ''}</td>
          <td class="nowrap">${esc(r.stream || r.type)}</td><td class="nowrap">${esc(r.category)}</td>
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
// Gate, home, method
// =====================================================================
function viewGate(p) {
  const what = { '/predict': 'the predictor', '/cutoffs': 'the cut-off tables', '/shortlist': 'your shortlist' }[p];
  S.intended = p;
  view.innerHTML = `<div class="gate">
    <div class="eyebrow" style="display:inline-flex;gap:8px;align-items:center">${icon.lock.replace('<svg', '<svg style="width:13px;height:13px"')} Members' tool</div>
    <h1>Sign up to open ${what}</h1>
    <p>Your name, mobile or email, NEET-PG CMR and state — then one code. We'll show cut-offs for your state.</p>
    <div class="auth-card" id="gate-auth"></div>
  </div>`;
  mountAuth($('#gate-auth'), { mode: 'signup' });
}

function viewHome() {
  // Latest published dataset per state, so several years don't double count.
  const latest = kind => { const seen = new Set(); return (S.cfg.datasets || []).filter(d => d.kind === kind && !seen.has(d.state) && seen.add(d.state)); };
  const total = (list, k) => list.reduce((n, d) => n + (d[k] || 0), 0);
  const st = latest('state'), aq = latest('aiq'), covered = S.cfg.dataStates || [];
  const year = st[0]?.year || 2025;
  view.innerHTML = `
  <a class="priority" href="/counselling"><div class="priority-in">
    <span class="eyebrow">NEET-PG 2026 counselling</span>
    <b>Live dates and step-by-step guides for All India (MCC), Gujarat, Karnataka and Kerala.</b>
    <span class="priority-go">Open the guide ${icon.arrowR}</span>
  </div></a>
  <section class="hero"><div class="hero-in">
    <div class="hero-copy">
      <div class="eyebrow">NEET-PG counselling · state quota and All India Quota</div>
      <h1>Know where your rank lands <em>before</em> you lock a choice.</h1>
      <p class="hero-lede">Every seat in your state's counselling and the All India Quota — by college, speciality, stream and
        category — with the ranks that actually got in. Sign up with your NEET-PG CMR and state to see what was within reach.</p>
      <div class="hero-cta"><a class="btn btn-line btn-lg" href="/method" data-link>How it works</a></div>
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
    <div class="stat"><span class="eyebrow">States with data</span><strong>${fmt(covered.length)}</strong><span>${esc(covered.join(', ') || '—')} · more being added</span></div>
  </div></section>

  <section class="section">
    <div class="section-head">
      <div><div class="eyebrow">How it works</div><h2>Three steps from rank to a choice list.</h2></div>
      <p>RankRound reads last year's admission results so you can see which seats your rank would have reached — and how
        comfortably — before you spend a single preference on them.</p>
    </div>
    <div class="steps">
      <div class="step"><span class="num">01</span><h3>Sign up with your rank</h3><p>Your NEET-PG CMR and your state. For the All India Quota, enter your NEET All India Rank. Pick your stream and category.</p></div>
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
      $('#ha-eye').textContent = m === 'signup' ? 'Free sign-up' : 'Welcome back';
      $('#ha-title').textContent = m === 'signup' ? 'Create your account' : 'Sign in';
    }
  });
  $('#to-signup').onclick = () => {
    $('#home-auth').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    $('#home-auth input')?.focus({ preventScroll: true });
  };
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
      <p><b>State counselling</b> comes from the Odisha state counselling result — every admission across all rounds, including the
        stray round. It is the only source that records the <b>direct and in-service</b> split and the round each seat went in.</p>
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
      <p>Seats more than 15% past their closing rank are left out. The <b>margin</b> column is the closing rank minus yours: positive means
        you were inside the cut-off by that many ranks.</p>
      <p>When you choose a reserved category, unreserved (UR) or General seats are included by default, because reserved-category
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
