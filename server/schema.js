// Dataset definitions: what columns each kind of upload has, how messy
// spreadsheet headers map onto them, and how per-candidate allotment lists
// are rolled up into the per-seat cut-off rows the predictor works on.

export const KINDS = {
  state: {
    label: 'State counselling',
    table: 'state_rows',
    rank: 'CMR',
    key: ['college', 'speciality', 'programme', 'stream', 'category'],
    columns: [
      { name: 'college', type: 'text', label: 'College' },
      { name: 'speciality', type: 'text', label: 'Speciality' },
      { name: 'programme', type: 'text', label: 'Programme' },
      { name: 'stream', type: 'stream', label: 'Stream' },
      { name: 'category', type: 'text', label: 'Category' },
      // Seat pool where a state publishes one (Gujarat: Government, University, Management, NRI, In-service).
      { name: 'quota', type: 'text', label: 'Quota', optional: true },
      // 0 = not published (Gujarat publishes only the last admitted rank per seat group).
      { name: 'seats', type: 'int', label: 'Seats', optional: true },
      { name: 'cmr_open', type: 'int', label: 'CMR opening', min: 1 },
      { name: 'cmr_close', type: 'int', label: 'CMR closing', min: 1 },
      { name: 'air_open', type: 'int', label: 'AIR opening', optional: true },
      { name: 'air_close', type: 'int', label: 'AIR closing', optional: true },
      { name: 'air_seen', type: 'int', label: 'AIR seen', optional: true },
      { name: 'rounds', type: 'text', label: 'Rounds', optional: true }
    ],
    allotment: [
      { name: 'college', type: 'text', label: 'College' },
      { name: 'speciality', type: 'text', label: 'Speciality' },
      { name: 'programme', type: 'text', label: 'Programme' },
      { name: 'stream', type: 'stream', label: 'Stream' },
      { name: 'category', type: 'text', label: 'Category' },
      { name: 'quota', type: 'text', label: 'Quota', optional: true },
      { name: 'cmr', type: 'int', label: 'CMR', min: 1 },
      { name: 'air', type: 'int', label: 'NEET AIR', optional: true },
      { name: 'round', type: 'text', label: 'Round', optional: true }
    ]
  },
  aiq: {
    label: 'All India Quota',
    table: 'aiq_rows',
    rank: 'AIR',
    key: ['college', 'branch', 'category'],
    columns: [
      { name: 'college', type: 'text', label: 'College' },
      { name: 'type', type: 'ctype', label: 'College type' },
      { name: 'branch', type: 'text', label: 'Branch' },
      { name: 'category', type: 'text', label: 'Category' },
      // MCC's quota where known: All India, Self-Financed Merit Seat (deemed), DNB, NRI, university quotas…
      { name: 'quota', type: 'text', label: 'Quota', optional: true },
      { name: 'seats', type: 'int', label: 'Seats', min: 1 },
      { name: 'open_rank', type: 'int', label: 'Opening rank', min: 1 },
      { name: 'close_rank', type: 'int', label: 'Closing rank', min: 1 }
    ],
    allotment: [
      { name: 'college', type: 'text', label: 'College' },
      { name: 'type', type: 'ctype', label: 'College type' },
      { name: 'branch', type: 'text', label: 'Branch' },
      { name: 'category', type: 'text', label: 'Category' },
      { name: 'quota', type: 'text', label: 'Quota', optional: true },
      { name: 'air', type: 'int', label: 'NEET AIR', min: 1 }
    ]
  }
};

// Header spellings seen in counselling spreadsheets, after normalisation
// (lower case, letters and digits only).
const ALIASES = {
  college: ['college', 'collegename', 'institute', 'institution', 'allottedinstitute', 'allottedcollege'],
  speciality: ['speciality', 'specialty', 'subject', 'discipline', 'course'],
  programme: ['programme', 'program', 'degree', 'coursetype'],
  branch: ['branch', 'course', 'subject', 'speciality', 'specialty'],
  stream: ['stream', 'quota', 'candidatetype', 'directinservice'], // a lone "Quota" column holding Direct/In-service
  quota: ['quota', 'seatquota', 'quotatype', 'quotacode'],
  category: ['category', 'cat', 'allottedcategory', 'seatcategory'],
  type: ['type', 'collegetype', 'management', 'ownership'],
  seats: ['seats', 'seat', 'count', 'admissions', 'intake'],
  cmr_open: ['cmropen', 'cmropening', 'openingcmr', 'cmrfrom'],
  cmr_close: ['cmrclose', 'cmrclosing', 'closingcmr', 'cmrto'],
  air_open: ['airopen', 'airopening', 'openingair'],
  air_close: ['airclose', 'airclosing', 'closingair'],
  air_seen: ['airseen', 'airavailable', 'airlisted'],
  rounds: ['rounds', 'round', 'roundsseen'],
  open_rank: ['openrank', 'opening', 'openingrank', 'open'],
  close_rank: ['closerank', 'closing', 'closingrank', 'close', 'cutoff'],
  cmr: ['cmr', 'statemeritrank', 'meritrank', 'staterank', 'rank'],
  air: ['air', 'neetair', 'allindiarank', 'neetrank', 'rank'],
  round: ['round', 'roundno', 'allotmentround']
};

const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Map an uploaded header row onto column names. Returns {map, missing}. */
export function mapHeaders(headers, columns) {
  const normed = headers.map(norm);
  const map = {};
  const used = new Set();
  for (const col of columns) {
    const options = [norm(col.name), norm(col.label), ...(ALIASES[col.name] || [])];
    for (const opt of options) {
      const i = normed.findIndex((h, j) => h === opt && !used.has(j));
      if (i >= 0) { map[col.name] = i; used.add(i); break; }
    }
  }
  const missing = columns.filter(c => !c.optional && !(c.name in map)).map(c => c.label);
  return { map, missing };
}

function normStream(v) {
  const s = norm(v);
  if (!s) return null;
  if (s.startsWith('d') || s === 'open' || s === 'general') return 'Direct';
  if (s.startsWith('in') || s === 'is' || s.includes('service')) return 'In-service';
  return null;
}
function normType(v) {
  const s = norm(v);
  if (s.startsWith('gov') || s === 'g' || s === 'state' || s === 'central') return 'Government';
  if (s.startsWith('pri') || s === 'p' || s.includes('deemed') || s.includes('management')) return 'Private';
  return null;
}

/** Coerce and validate one value. Returns [value, errorMessage]. */
export function coerce(col, raw) {
  const blank = raw === undefined || raw === null || String(raw).trim() === '';
  if (blank) {
    if (col.optional) return [col.type === 'int' ? 0 : '', null];
    return [null, `${col.label} is empty`];
  }
  if (col.type === 'int') {
    const n = Number(String(raw).replace(/[,\s]/g, ''));
    if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) return [null, `${col.label} "${raw}" is not a whole number`];
    if (col.min && n < col.min) return [null, `${col.label} must be at least ${col.min}`];
    return [n, null];
  }
  if (col.type === 'stream') {
    const v = normStream(raw);
    return v ? [v, null] : [null, `Stream "${raw}" should be Direct or In-service`];
  }
  if (col.type === 'ctype') {
    const v = normType(raw);
    return v ? [v, null] : [null, `College type "${raw}" should be Government or Private`];
  }
  return [String(raw).replace(/\s+/g, ' ').trim(), null];
}

/**
 * Turn a 2-D array (first row = headers) into validated records.
 * Returns { rows, errors, missing } — errors are capped so a bad file
 * doesn't produce a 10,000-line report.
 */
export function parseTable(table, columns) {
  const [headers = [], ...body] = table;
  const { map, missing } = mapHeaders(headers, columns);
  if (missing.length) return { rows: [], errors: [], missing };
  const rows = [], errors = [];
  body.forEach((line, i) => {
    if (!line || line.every(c => String(c ?? '').trim() === '')) return;
    const rec = {};
    let bad = false;
    for (const col of columns) {
      const [v, err] = coerce(col, col.name in map ? line[map[col.name]] : undefined);
      if (err) { bad = true; if (errors.length < 50) errors.push({ line: i + 2, message: err }); }
      rec[col.name] = v;
    }
    if (!bad) rows.push(rec);
  });
  return { rows, errors, missing: [] };
}

/** Validate a single record (admin row editor). Returns [record, errors]. */
export function validateRecord(kind, input) {
  const rec = {}, errors = [];
  for (const col of KINDS[kind].columns) {
    const [v, err] = coerce(col, input[col.name]);
    if (err) errors.push(err);
    rec[col.name] = v;
  }
  if (!errors.length) {
    const [o, c] = kind === 'state' ? ['cmr_open', 'cmr_close'] : ['open_rank', 'close_rank'];
    if (rec[o] > rec[c]) errors.push('Opening rank must not be worse than closing rank');
  }
  return [rec, errors];
}

const roundOrder = r => {
  const m = /^(UGR|R)-(\d+|\?)$/.exec(r);
  if (!m) return 99;
  return (m[1] === 'UGR' ? 10 : 0) + (m[2] === '?' ? 9 : +m[2]);
};
const normRound = r => {
  const s = String(r || '').toUpperCase().replace(/\s+/g, '');
  if (!s) return 'R-?';
  const m = /^(UGR|UG|R|ROUND)?-?(\d+)$/.exec(s);
  if (m) return (m[1] && m[1].startsWith('UG') ? 'UGR-' : 'R-') + m[2];
  return s;
};

/** Roll one-row-per-candidate allotments up into per-seat cut-off rows. */
export function aggregate(kind, allotments) {
  const def = KINDS[kind];
  const groups = new Map();
  for (const a of allotments) {
    const k = def.key.map(f => a[f]).join('\u0001') + '\u0001' + (kind === 'aiq' ? a.type + '\u0001' : '') + (a.quota || '');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  const out = [];
  for (const list of groups.values()) {
    const f = list[0];
    if (kind === 'state') {
      const cmr = list.map(a => a.cmr);
      const air = list.map(a => a.air).filter(n => n > 0);
      const rounds = [...new Set(list.map(a => normRound(a.round)))].sort((x, y) => roundOrder(x) - roundOrder(y));
      out.push({
        college: f.college, speciality: f.speciality, programme: f.programme, stream: f.stream,
        category: f.category, quota: f.quota || '', seats: list.length,
        cmr_open: Math.min(...cmr), cmr_close: Math.max(...cmr),
        air_open: air.length ? Math.min(...air) : 0, air_close: air.length ? Math.max(...air) : 0,
        air_seen: air.length, rounds: rounds.join(' ')
      });
    } else {
      const air = list.map(a => a.air);
      out.push({
        college: f.college, type: f.type, branch: f.branch, category: f.category, quota: f.quota || '', seats: list.length,
        open_rank: Math.min(...air), close_rank: Math.max(...air)
      });
    }
  }
  return out;
}
