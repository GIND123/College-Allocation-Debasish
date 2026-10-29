// Counselling guides: the client's stand-alone HTML guides in guides/, served at
// /counselling/<slug>. The files stay exactly as the client sent them. The RankRound
// frame (top bar, guide bar, footer, fonts and theme) is added as each page is served,
// so an updated guide is published by replacing its file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATES } from './states.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const GUIDES_DIR = path.join(here, '..', 'guides');
const REGISTRY = path.join(GUIDES_DIR, 'guides.json');
export const ALL_INDIA = 'All India';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ---- registry (guides/guides.json) --------------------------------------
let loaded = { mtime: 0, data: null };

/** guides.json, re-read whenever the file changes. Throws a clear error for a bad entry. */
export function registry() {
  const mtime = fs.statSync(REGISTRY).mtimeMs;
  if (mtime !== loaded.mtime) loaded = { mtime, data: validate(JSON.parse(fs.readFileSync(REGISTRY, 'utf8'))) };
  return loaded.data;
}

function validate(data) {
  const seen = new Set();
  for (const g of data.guides || []) {
    const where = `guides/guides.json, guide "${g.slug}"`;
    if (!SLUG.test(g.slug || '')) throw new Error(`${where}: the slug must be lower-case words joined by hyphens.`);
    if (seen.has(g.slug)) throw new Error(`${where}: the slug is used twice.`);
    seen.add(g.slug);
    if (!g.title || !g.label) throw new Error(`${where}: needs a title and a label.`);
    if (g.region !== ALL_INDIA && !STATES.includes(g.region)) throw new Error(`${where}: region must be "${ALL_INDIA}" or a state name from server/states.js.`);
    if (!/^[\w.-]+\.html$/.test(g.file || '') || !fs.existsSync(path.join(GUIDES_DIR, g.file))) throw new Error(`${where}: file "${g.file}" is not in guides/.`);
    for (const d of g.dates || []) {
      for (const k of ['from', 'to', 'on']) if (d[k] && Number.isNaN(Date.parse(d[k]))) throw new Error(`${where}: "${d.what}" has an invalid "${k}" date.`);
      if (!d.label && !d.on && !d.to) throw new Error(`${where}: "${d.what}" needs "on", "to" or a "label".`);
    }
  }
  let prev = -Infinity;
  for (const st of data.roadmap?.stages || []) {
    const where = `guides/guides.json, roadmap stage "${st.name}"`;
    const from = Date.parse(st.from), to = Date.parse(st.to);
    if (!st.name || Number.isNaN(from) || Number.isNaN(to) || from > to) throw new Error(`${where}: needs a name and valid "from" and "to" dates, in order.`);
    if (from < prev) throw new Error(`${where}: stages must be in date order.`);
    prev = to;
  }
  const kinds = Object.keys(data.seats?.kinds || {});
  for (const [st, e] of Object.entries(data.seats?.states || {})) {
    const where = `guides/guides.json, seats for "${st}"`;
    if (!STATES.includes(st)) throw new Error(`${where}: not a state name from server/states.js.`);
    for (const [k, v] of Object.entries(e)) {
      if (k === 'note') continue;
      if (!kinds.includes(k)) throw new Error(`${where}: "${k}" is not one of the seat kinds (${kinds.join(', ')}).`);
      if (!Number.isInteger(v) || v < 0) throw new Error(`${where}: "${k}" must be a whole number.`);
    }
  }
  const region = r => r === ALL_INDIA || STATES.includes(r);
  const files = new Set();
  for (const d of data.documents || []) {
    const where = `guides/guides.json, document "${d.title}"`;
    if (!d.title || !region(d.region)) throw new Error(`${where}: needs a title and a region ("${ALL_INDIA}" or a state name).`);
    if (!/^[\w-]+(\/[\w.-]+)+$/.test(d.file || '') || !fs.existsSync(path.join(GUIDES_DIR, 'assets', d.file))) throw new Error(`${where}: file "${d.file}" is not in guides/assets/.`);
    if (Number.isNaN(Date.parse(d.date))) throw new Error(`${where}: needs a valid "date".`);
    files.add(d.file);
  }
  for (const u of data.updates || []) {
    const where = `guides/guides.json, update "${String(u.text).slice(0, 40)}"`;
    if (!u.text || !region(u.region) || Number.isNaN(Date.parse(u.date))) throw new Error(`${where}: needs text, a region and a valid "date".`);
    if (u.doc && !files.has(u.doc)) throw new Error(`${where}: "doc" must be the file of one of the documents.`);
    if (u.link && !u.link.startsWith('/')) throw new Error(`${where}: "link" must be a path on this site.`);
  }
  return data;
}

/** Where a state's official documents are listed on /counselling. */
export const docsAnchor = region => 'docs-' + region.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/** Everything the site shows about the guides, without file names. */
export function guideList() {
  return registry().guides.map(({ file, ...g }) => g);
}
export const compareTable = () => registry().compare || null;
export const roadmap = () => registry().roadmap || null;
export const stateSeats = () => registry().seats || null;
export const documents = () => registry().documents || [];
export const updates = () => registry().updates || [];

// ---- pages ----------------------------------------------------------------
const pages = new Map();

/** The framed page for a guide, or null if there is no such guide. Cached until a file changes. */
export function guidePage(slug) {
  const all = registry().guides;
  const g = all.find(x => x.slug === slug);
  if (!g) return null;
  const key = `${fs.statSync(path.join(GUIDES_DIR, g.file)).mtimeMs}:${loaded.mtime}`;
  const hit = pages.get(slug);
  if (hit?.key === key) return hit.html;
  const html = frame(fs.readFileSync(path.join(GUIDES_DIR, g.file), 'utf8'), g, all);
  pages.set(slug, { key, html });
  return html;
}

const FONTS = 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Source+Serif+4:ital,opsz,wght@0,8..60,500;0,8..60,600;1,8..60,500&display=swap';
const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%230b1422'/%3E%3Cpath d='M18 46V18h14a9 9 0 0 1 2 17.8L44 46h-8l-9-10h-2v10z M25 30h7a3 3 0 0 0 0-6h-7z' fill='%23d6ab5a'/%3E%3C/svg%3E";
const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" aria-hidden="true">${d}</svg>`;
const MOON = svg('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>');
const BACK = svg('<path d="M19 12H5M11 6l-6 6 6 6"/>');
const OUT = svg('<path d="M14 5h5v5M19 5l-8 8M18 14v5H5V6h5"/>');
// Same light/dark choice as the rest of the site, applied before the guide's CSS paints.
// Wrapped in a function: a global `var` here would clash with a guide's own top-level names.
const THEME_BOOT = `<script>(function(){try{var t=localStorage.getItem('rr-theme');if(t)document.documentElement.dataset.theme=JSON.parse(t)}catch(e){}})()</script>`;

// Some guides turn dark only from the operating system setting. Their dark rules are
// rewritten to follow the site's light/dark switch (data-theme on <html>) as well, the way
// the other guides already do:
//   @media (prefers-color-scheme: dark){ .x{…} }
//   → @media (prefers-color-scheme: dark){ :root:not([data-theme="light"]) .x{…} } :root[data-theme="dark"] .x{…}
const DARK_MEDIA = /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{/gi;
const topLevelParts = sel => {
  const parts = []; let depth = 0, cur = '';
  for (const ch of sel) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && !depth) { parts.push(cur); cur = ''; } else cur += ch;
  }
  return [...parts, cur].map(s => s.trim()).filter(Boolean);
};
const scoped = (sel, cond) => topLevelParts(sel)
  .map(s => /^(:root|html)\b/.test(s) ? s.replace(/^(:root|html)/, `$1${cond}`) : `:root${cond} ${s}`).join(', ');

export function followSiteTheme(css) {
  let out = '', last = 0, m;
  DARK_MEDIA.lastIndex = 0;
  while ((m = DARK_MEDIA.exec(css))) {
    let i = m.index + m[0].length, depth = 1;
    while (i < css.length && depth) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++; }
    const body = css.slice(m.index + m[0].length, i - 1).replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    if (rules.some(([, sel]) => !sel.includes('data-theme'))) {
      const inside = [], outside = [];
      for (const [, sel, decls] of rules) {
        if (sel.includes('data-theme')) { inside.push(`${sel.trim()}{${decls}}`); continue; }
        inside.push(`${scoped(sel, ':not([data-theme="light"])')}{${decls}}`);
        outside.push(`${scoped(sel, '[data-theme="dark"]')}{${decls}}`);
      }
      out += css.slice(last, m.index) + `@media (prefers-color-scheme: dark){${inside.join('')}}${outside.join('')}`;
      last = i;
    }
    DARK_MEDIA.lastIndex = i;
  }
  return out + css.slice(last);
}

// The guides' own web fonts aren't loaded (RankRound's are), so a font named directly in a
// guide's CSS is swapped for RankRound's equivalent. Only font declarations are touched, and
// custom properties holding a font list (--display: "Archivo", sans-serif).
const FONT_SWAPS = [
  [/(["']?)\b(?:JetBrains Mono|IBM Plex Mono)\b\1/g, '"Geist Mono"'],
  [/(["']?)\b(?:Fraunces|Literata|Bricolage Grotesque)\b\1/g, '"Source Serif 4"'],
  [/(["']?)\b(?:Inter|Figtree|IBM Plex Sans|Source Sans 3|Public Sans|Archivo)\b\1/g, 'Geist']
];
const GENERIC_FAMILY = /\b(?:serif|sans-serif|monospace|system-ui|ui-monospace|ui-sans-serif|ui-serif)\b/;
export const siteFonts = css => css.replace(/(\bfont(?:-family)?\s*:\s*|--[\w-]+\s*:\s*)([^;}]+)/gi,
  (all, prop, value) => prop.startsWith('--') && !GENERIC_FAMILY.test(value) ? all
    : prop + FONT_SWAPS.reduce((v, [re, to]) => v.replace(re, to), value));

const noticeDate = iso => new Date(`${iso}T00:00:00+05:30`)
  .toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

// The frame uses div elements with landmark roles, not header/nav/footer: the guides style
// those bare elements (and a, p, b, button) for their own layout.
function topBar(g, all) {
  const same = g.region === ALL_INDIA ? [g] : all.filter(x => x.region === g.region);
  const docs = same.length > 1
    ? `<span class="rr-docs">${same.map(x => `<a href="/counselling/${x.slug}"${x.slug === g.slug ? ' aria-current="page"' : ''}>${esc(x.label)}</a>`).join('')}</span>`
    : `<span class="rr-doc">${esc(g.label)}</span>`;
  const nDocs = documents().filter(d => d.region === g.region).length;
  return `
<div class="rr-top" role="banner" data-rr>
  <div class="rr-top-in">
    <a class="rr-mark" href="/"><b>Rank<em>Round</em></b><small>PG Counselling Intelligence</small></a>
    <div class="rr-nav" role="navigation" aria-label="Main">
      <a href="/predict">Intelligent prediction</a>
      <a href="/counselling" aria-current="page">Counselling guide</a>
      <a href="/method">Method</a>
    </div>
    <div class="rr-right">
      <button class="rr-icon" id="rr-theme" type="button" aria-label="Switch light / dark">${MOON}</button>
      <a class="rr-cta" href="/predict">Check my options</a>
    </div>
  </div>
</div>
<div class="rr-guidebar" role="navigation" aria-label="Counselling guides" data-rr>
  <div class="rr-guidebar-in">
    <a class="rr-back" href="/counselling">${BACK}<span>All guides</span></a>
    <span class="rr-where">${esc(g.region)}</span>
    ${docs}
    <span class="rr-meta">${g.asOf ? `<span>Notice of ${noticeDate(g.asOf)}</span>` : ''}${nDocs
      ? `<a href="/counselling#${docsAnchor(g.region)}">Official documents (${nDocs})</a>` : ''}${g.official
      ? `<a href="${esc(g.official)}" target="_blank" rel="noopener">Official site${OUT}</a>` : ''}</span>
  </div>
</div>
`;
}

const FOOT = `
<div class="rr-foot" role="contentinfo" data-rr>
  <div class="rr-foot-in">
    <div>
      <b class="rr-wm">RankRound</b>
      <p>Plain-language guides to NEET-PG counselling notices, with a rank predictor and cut-offs for your state.</p>
      <p><a href="/counselling">All counselling guides</a> · <a href="/predict">Rank predictor</a> · <a href="/method">Method &amp; sources</a></p>
    </div>
    <p><b>Independent and unofficial.</b> These guides summarise official notices to make them easier to read. They are not produced
      or endorsed by any counselling authority, and dates and rules change: always confirm on the official website before acting.</p>
  </div>
</div>
<script type="module" src="/js/guide.js"></script>
`;

// <html>, <head> and <body> tags are optional in HTML, and some guides leave them out (CENTAC;
// Himachal Pradesh is a bare fragment). They are added where a browser would put them, so the
// frame always has the same places to go: the body starts at the first tag that can't be in the
// head. A missing doctype would put the page in quirks mode, so one is added too.
const HEAD_TAGS = new Set(['html', 'head', 'meta', 'title', 'link', 'style', 'script', 'base', 'noscript', 'template']);
function withHeadAndBody(h) {
  if (!/<html\b/i.test(h)) h = `<html lang="en">${h}</html>`;
  if (!/^\s*(<!--[\s\S]*?-->\s*)*<!doctype/i.test(h)) h = `<!doctype html>\n${h}`;
  if (/<\/head>/i.test(h) && /<body\b/i.test(h)) return h;
  const tag = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-z][\w-]*)[^>]*>/gi;
  let at = h.length, m;
  while ((m = tag.exec(h))) {
    if (!m[2]) continue;
    const name = m[2].toLowerCase();
    if (!m[1] && (name === 'style' || name === 'script')) { // skip their contents, which may contain "<"
      const end = h.toLowerCase().indexOf(`</${name}`, tag.lastIndex);
      tag.lastIndex = end < 0 ? h.length : end;
      continue;
    }
    if (!m[1] && !HEAD_TAGS.has(name)) { at = m.index; break; }
  }
  const head = /<head\b/i.test(h) ? '' : '<head>';
  h = `${h.slice(0, at)}${/<\/head>/i.test(h) ? '' : '</head>'}${/<body\b/i.test(h) ? '' : '<body>'}${h.slice(at)}`;
  return head ? h.replace(/<html\b[^>]*>/i, x => x + head) : h;
}

function frame(src, g, all) {
  let h = withHeadAndBody(src)
    .replace(/<link\b[^>]*\bhref=["']https:\/\/fonts\.(?:googleapis|gstatic)\.com[^"']*["'][^>]*>\s*/gi, '') // RankRound's fonts replace the guide's
    .replace(/<meta\s+name=["']description["'][^>]*>\s*/gi, '')
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, open, css, close) => open + siteFonts(followSiteTheme(css)) + close);
  const title = "<title>RankRound</title>"; // the tab shows the brand only; the guide title is in the page
  h = /<title>[\s\S]*?<\/title>/i.test(h) ? h.replace(/<title>[\s\S]*?<\/title>/i, title) : h.replace(/<\/head>/i, `${title}</head>`);
  h = h.replace(/<html\b/i, `<html data-guide="${g.slug}"`);
  h = h.replace(/<head\b[^>]*>/i, m => m + THEME_BOOT);
  // A guide without these would render at desktop width on phones, or guess its encoding.
  const needs = `${/<meta\s+charset/i.test(h) ? '' : '<meta charset="utf-8">\n'}${/name=["']viewport["']/i.test(h) ? '' : '<meta name="viewport" content="width=device-width, initial-scale=1">\n'}`;
  h = h.replace(/<\/head>/i, `${needs}<meta name="description" content="${esc(g.summary || g.title)}">
<meta name="theme-color" content="#0b1422">
<link rel="icon" href="${FAVICON}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="/css/guide.css">
</head>`);
  h = h.replace(/<body\b[^>]*>/i, m => m + topBar(g, all));
  const end = [h.lastIndexOf('</body>'), h.lastIndexOf('</html>')].find(i => i >= 0) ?? -1;
  return end < 0 ? h + FOOT : h.slice(0, end) + FOOT + h.slice(end);
}
