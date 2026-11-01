// A guide's sections (one per <h2>), cleaned down to plain content so every guide can be read in
// the same RankRound layout on the counselling roadmap page. Only structure survives (paragraphs,
// lists, tables, headings, emphasis, links out); the guide's own classes, styles, scripts and
// widgets are dropped. The original page stays available at /counselling/<slug>.
import fs from 'node:fs';
import path from 'node:path';

// Kept as they are (attributes dropped, except the few listed in ATTRS).
const KEEP = new Set(['p', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'h3', 'h4', 'h5', 'b', 'strong', 'i', 'em', 'small', 'sub', 'sup', 'br', 'code', 'mark', 'blockquote', 'hr', 'div',
  'details', 'summary', 'a']);
const RENAME = { h1: 'h3', h2: 'h3', h6: 'h5', section: 'div', article: 'div', aside: 'div', figure: 'div', figcaption: 'p',
  header: 'div', main: 'div', label: 'span', time: 'span' };
// Dropped with everything inside them.
const DROP = new Set(['script', 'style', 'svg', 'button', 'input', 'select', 'textarea', 'form', 'nav', 'noscript', 'template',
  'iframe', 'canvas', 'img', 'picture', 'video', 'audio', 'object', 'footer', 'dialog']);
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr', 'col', 'source']);
const ATTRS = { td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'], a: ['href'], details: ['open'] };

const decode = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&[a-z]+;/gi, ' ');
const escText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = s => escText(s).replace(/"/g, '&quot;');
export const textOf = html => decode(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').replace(/ ([,.;:)])/g, '$1').replace(/\( /g, '(').trim();

/** Clean a piece of guide HTML down to plain structure. Unbalanced tags are closed or ignored. */
export function clean(html) {
  const out = [], stack = [];
  const tag = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g;
  let last = 0, m, skip = null;
  const text = s => { if (!skip && s) out.push(escText(decode(s))); };
  while ((m = tag.exec(html))) {
    text(html.slice(last, m.index));
    last = tag.lastIndex;
    if (!m[2]) continue; // a comment
    const close = !!m[1], name = m[2].toLowerCase();
    if (skip) { if (close && name === skip.name && !--skip.depth) skip = null; else if (!close && name === skip.name) skip.depth++; continue; }
    if (DROP.has(name)) {
      if (!close && !VOID.has(name) && !/\/\s*$/.test(m[3])) skip = { name, depth: 1 };
      continue;
    }
    const to = RENAME[name] || (KEEP.has(name) ? name : null);
    if (!to) continue; // unwrapped: the text inside stays
    if (close) {
      const at = stack.findLastIndex(t => t === to || t.endsWith(':' + to));
      if (at < 0) continue;
      while (stack.length > at) out.push(`</${stack.pop().split(':')[0]}>`);
      continue;
    }
    let attrs = '';
    for (const a of ATTRS[to] || []) {
      const v = new RegExp(`\\b${a}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(m[3]);
      if (!v && a === 'open' && /\bopen\b/i.test(m[3])) attrs += ' open';
      if (!v) continue;
      const val = decode(v[2] ?? v[3] ?? v[4] ?? '');
      if (a === 'href') {
        if (!/^https?:\/\//i.test(val)) continue; // links within the guide don't work out of it
        attrs += ` href="${escAttr(val)}" target="_blank" rel="noopener"`;
      } else if (/^\d{1,2}$/.test(val)) attrs += ` ${a}="${val}"`;
    }
    if (to === 'a' && !attrs) { stack.push('span:a'); out.push('<span>'); continue; } // a link within the guide: its text only
    out.push(`<${to}${attrs}>`);
    if (!VOID.has(to)) stack.push(to);
  }
  text(html.slice(last));
  while (stack.length) out.push(`</${stack.pop().split(':')[0]}>`);
  return out.join('')
    .replace(/<(p|div|li|span|h[3-5]|strong|b|em|i|small)>\s*<\/\1>/g, '') // empty after cleaning
    .replace(/(<div>\s*<\/div>)+/g, '').replace(/\n\s*\n+/g, '\n').trim();
}

const slugify = s => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
// "1At a glance", "📅 Counselling Schedule", "2. What's new" → the heading itself.
const tidyTitle = s => s.replace(/^[\s\d.:)\-–—\p{Extended_Pictographic}️‍]+/u, '').trim();

const cache = new Map();
/** [{id, title, blurb, html}] for one guide file, re-read when the file changes. */
export function sections(file) {
  const mtime = fs.statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit?.mtime === mtime) return hit.list;
  let src = fs.readFileSync(file, 'utf8');
  src = src.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  const end = src.search(/<footer\b/i);
  if (end > 0) src = src.slice(0, end);
  const heads = [...src.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)];
  const list = [], seen = new Set();
  heads.forEach((h, i) => {
    const title = tidyTitle(textOf(h[1]));
    if (!title) return;
    const body = clean(src.slice(h.index + h[0].length, i + 1 < heads.length ? heads[i + 1].index : src.length));
    const words = textOf(body);
    if (words.length < 40) return; // an interactive widget or an empty heading: nothing to read here
    let id = slugify(title) || 'section';
    while (seen.has(id)) id += '-2';
    seen.add(id);
    const first = textOf((/<p>([\s\S]*?)<\/p>/.exec(body) || [, words])[1]);
    const blurb = first.length > 120 ? first.slice(0, 117).replace(/\s+\S*$/, '') + '…' : first;
    list.push({ id, title, blurb, html: body });
  });
  cache.set(file, { mtime, list });
  return list;
}

export const sectionsOf = (dir, g) => sections(path.join(dir, g.file));
