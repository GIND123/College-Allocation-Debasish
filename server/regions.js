// One counselling roadmap page per region (All India, or a state): where its counselling stands,
// its dates, its guides in a common layout, and its data (merit list, seat matrix, allotments).
// Guides and dates are for everyone. Data needs an account: All India data for any signed-in
// candidate, a state's data only for candidates registered for that state.
import fs from 'node:fs';
import path from 'node:path';
import { registry, guideList, documents, GUIDES_DIR, ALL_INDIA, STAGES, DATA_DIR } from './guides.js';
import { sections } from './sections.js';
import { STATES } from './states.js';

export const regionKey = r => r.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const regionOf = key => [ALL_INDIA, ...STATES].find(r => regionKey(r) === key) || null;
// Review accounts open every state's data: the admin (signed in at /admin, in the same browser), and the mobile
// numbers in FULL_ACCESS_PHONES (comma-separated; spaces and +91 are fine). An env var, as the free tier's database is
// wiped on every restart.
const FULL = new Set((process.env.FULL_ACCESS_PHONES || '').split(/[,;\n]+/).map(p => p.replace(/\D/g, '').slice(-10)).filter(p => p.length === 10));
export const fullAccess = user => !!user?.review || (!!user?.phone && FULL.has(String(user.phone).replace(/\D/g, '').slice(-10)));
/** Who may load a region's data. */
export const access = (user, region, admin = false) => admin ? 'open' : !user ? 'signin'
  : region === ALL_INDIA || user.state === region || fullAccess(user) ? 'open' : 'locked';

const fileOf = g => path.join(GUIDES_DIR, registry().guides.find(x => x.slug === g.slug).file);

/** Everything public about a region, for its roadmap page. */
export function regionInfo(region, user, admin = false) {
  const reg = registry();
  const guides = guideList().filter(g => g.region === region);
  const dates = guides.flatMap(g => (g.dates || []).map(d => ({ ...d, slug: g.slug })));
  const data = (reg.data || []).filter(d => d.region === region)
    .map(({ file, ...d }) => ({ ...d, size: fs.statSync(path.join(DATA_DIR, file)).size }));
  return {
    region, key: regionKey(region), stages: STAGES, progress: reg.progress?.[region] || null,
    guides: guides.map(g => ({ slug: g.slug, label: g.label, title: g.title, summary: g.summary, authority: g.authority, official: g.official,
      sections: sections(fileOf(g)).map(({ id, title, blurb }) => ({ id, title, blurb })) })),
    dates, documents: documents().filter(d => d.region === region), data, access: access(user, region, admin),
    review: admin ? 'admin' : fullAccess(user) ? 'account' : null
  };
}

/** One guide section, cleaned to plain content; null when there is no such section. */
export function sectionOf(slug, id) {
  const g = guideList().find(x => x.slug === slug);
  return g ? sections(fileOf(g)).find(s => s.id === id) || null : null;
}

const loaded = new Map();
/** A region's data file (parsed once per change), or null when the region has no such data. */
export function regionData(region, id) {
  const d = (registry().data || []).find(x => x.region === region && x.id === id);
  if (!d) return null;
  const file = path.join(DATA_DIR, d.file), mtime = fs.statSync(file).mtimeMs;
  if (loaded.get(file)?.mtime !== mtime) loaded.set(file, { mtime, json: fs.readFileSync(file, 'utf8') });
  return { meta: d, json: loaded.get(file).json };
}
