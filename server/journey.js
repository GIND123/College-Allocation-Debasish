// Rank journey: for every NEET-PG All India Rank, the seat it was given in All India counselling (MCC) and in each state's
// counselling, from the allotment lists on the roadmap pages. A state seat is matched only where the state's list gives the
// candidate's NEET-PG rank (some lists print only the state merit position, and those can't be joined).
import fs from 'node:fs';
import path from 'node:path';
import { registry, DATA_DIR, ALL_INDIA } from './guides.js';

let cache = { key: '', json: '' };

/** The journey data as one compact JSON string: string tables plus [air, [set, college, course, quota, category, type, programme, status]…] rows. */
export function journeyJson() {
  const sets = (registry().data || []).filter(d => d.kind === 'allotment');
  const files = sets.map(d => path.join(DATA_DIR, d.file));
  const key = files.map(f => `${f}:${fs.statSync(f).mtimeMs}`).join('|');
  if (cache.key === key) return cache.json;

  const strings = [], index = new Map();
  const s = v => { v = String(v ?? ''); if (!index.has(v)) { index.set(v, strings.length); strings.push(v); } return index.get(v); };
  const byAir = new Map();
  const add = (air, seat) => { if (!(air > 0)) return; if (!byAir.has(air)) byAir.set(air, []); byAir.get(air).push(seat); };
  const out = [];
  sets.forEach((d, i) => {
    const D = JSON.parse(fs.readFileSync(files[i], 'utf8'));
    let matched = 0;
    if (D.format === 'mcc') {
      for (const r of D.rows) {
        add(r[0], [i, s(D.inst[r[1]]), s(D.course[r[4]]), s(D.quota[r[3]]), s(D.cat[r[5]]), s(D.type[r[7]] || ''), s(progOf(D.course[r[4]])), s(D.state[r[2]])]);
        matched++;
      }
    } else {
      const rankIsAir = /NEET AIR/i.test(D.rankLabel || '');
      for (const r of D.rows) {
        const air = rankIsAir ? r.rank : r.air;
        if (!(air > 0)) continue;
        add(air, [i, s(r.college), s(r.course), s(r.quota), s(r.category), s(r.type), s(r.programme), s(r.move || '')]);
        matched++;
      }
    }
    out.push({ region: d.region, label: d.short || d.title, round: d.round, date: d.date, id: d.id, rows: D.rows.length, matched });
  });
  const rows = [...byAir.entries()].sort((a, b) => a[0] - b[0]).map(([air, seats]) => [air, seats]);
  cache = { key, json: JSON.stringify({ allIndia: ALL_INDIA, sets: out, strings, rows }) };
  return cache.json;
}

// MD/MS, DNB or diploma from a course name, as the site reads it.
const progOf = v => /diploma/i.test(v) ? 'Diploma' : /^(DNB|NBEMS)\b|\bDNB\b/i.test(v) ? 'DNB' : 'MD/MS';
