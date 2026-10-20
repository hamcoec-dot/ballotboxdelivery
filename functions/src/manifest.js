'use strict';
// Parsing + manifest building for the per-election Hamilton County exports.
// Moved from index.html so expected seal numbers are only ever handled server-side.

const normSeal = (v) => String(v || '').trim().toUpperCase();

// Quote-aware CSV parser -> array of field arrays (handles BOM, CRLF, "" escapes)
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f.trim() !== '')) rows.push(row);
  return rows;
}

function csvToObjects(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => {
    const o = {};
    headers.forEach((h, i) => { if (!(h in o)) o[h] = (r[i] || '').trim(); });
    return o;
  });
}

// Precincts export has unquoted commas inside both address fields, so parse positionally.
function parsePrecinctsCSV(text, warn = () => {}) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  const iName = headers.indexOf('PollingPlaceName');
  const iMail = headers.indexOf('PollingPlaceMailingAddress');
  const iCpn = headers.indexOf('CountyPrecinctNum');
  const iPrec = headers.indexOf('PrecinctName');
  if (iName < 0 || iMail < 0 || iCpn < 0 || iPrec < 0) throw new Error('precincts.csv: unexpected header');
  const head = iName + 1;
  const tail = headers.length - (iMail + 1);
  const zipRe = /\b[A-Z]{2}\s+\d{5}(-\d{4})?\s*$/;
  const clean = (s) => s.replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ').trim();

  return lines.slice(1).map(line => {
    const f = line.split(',');
    const middle = f.slice(head, f.length - tail);
    const split = middle.findIndex(p => zipRe.test(p.trim()));
    let address;
    if (split < 0) {
      warn('Precinct row has no ZIP in its address; used a best guess: ' + f[iPrec].trim());
      address = middle.slice(0, Math.ceil(middle.length / 2)).join(',');
    } else {
      address = middle.slice(0, split + 1).join(',');
    }
    return {
      num: f[iCpn].trim(),
      name: f[iPrec].trim(),
      building: f[iName].trim(),
      address: clean(address)
    };
  });
}

function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s(\-\/&])([a-z])/g, (m, p, c) => p + c.toUpperCase());
}
function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---- Delivery schedule export -------------------------------------------------------------------
// Columns: Precinct (= the machine export's "Polling Place", uppercased), Day ("day.stop"), Polling Place ID,
// Ballot Boxes, one numeric column per supply, then Equipment / Contact. Supply columns are everything between
// "Ballot Boxes" and the "Adjust Row Hight in Points" print artifact (Equipment as fallback end marker).
const SUPPLY_END_MARKERS = ['Adjust Row Hight in Points', 'Equipment'];
const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function parseScheduleCSV(text, warn = () => {}) {
  const raw = parseCSV(text);
  if (raw.length < 2) throw new Error('Delivery schedule export is empty.');
  const headers = raw[0].map(h => h.trim());
  const col = (name) => headers.indexOf(name);
  const iPrec = col('Precinct'), iDay = col('Day'), iBoxes = col('Ballot Boxes'), iContact = col('Contact');
  if (iPrec < 0 || iDay < 0 || iBoxes < 0) throw new Error('Delivery schedule export: unexpected header (need Precinct, Day, Ballot Boxes).');
  const iPpId = col('Polling Place ID');
  let iEnd = -1;
  for (const m of SUPPLY_END_MARKERS) { const i = col(m); if (i > iBoxes) { iEnd = i; break; } }
  if (iEnd < 0) { warn('Delivery schedule: could not find the end of the supply columns; no supplies were read.'); iEnd = iBoxes + 1; }
  const supplyCols = [];
  for (let i = iBoxes + 1; i < iEnd; i++) {
    const label = collapse(headers[i]);
    if (label) supplyCols.push({ i, label, key: slugify(label) });
  }

  const num = (v, what) => {
    const t = String(v || '').trim();
    if (!t) return 0;
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) { warn(`Delivery schedule: "${t}" is not a valid quantity (${what}); treated as 0.`); return 0; }
    return Math.floor(n);
  };

  const rows = [];
  let totals = null;
  raw.slice(1).forEach((r) => {
    const get = (i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
    const dayText = get(iDay);
    if (!dayText) { totals = r; return; }                      // totals row
    const pp = get(iPrec);
    const m = dayText.match(/^(\d+)\.(\d+)$/);
    let day = null, stop = null;
    if (m) {
      day = Number(m[1]); stop = m[2];
      if (stop.length < 2) warn(`Delivery schedule: stop "${dayText}" (${pp}) has one digit after the dot; Excel may have dropped a zero (3.30 -> 3.3).`);
    } else {
      warn(`Delivery schedule: "${dayText}" (${pp}) is not in day.stop form.`);
    }
    rows.push({
      pp_name: pp,
      day, stop, route_label: dayText, route_index: rows.length,
      polling_place_id: get(iPpId),
      supplies: supplyCols.map(c => ({ key: c.key, label: c.label, qty: num(r[c.i], `${pp}, ${c.label}`) })).filter(s => s.qty > 0),
      ballot_boxes: num(r[iBoxes], `${pp}, Ballot Boxes`),
      contacts: iContact >= 0 ? get(iContact).split('|').map(collapse).filter(Boolean) : []
    });
  });

  // The file order is the route; warn if it is not sorted by day.stop
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    if (a.day != null && b.day != null && (b.day < a.day || (b.day === a.day && Number(b.stop) < Number(a.stop)))) {
      warn(`Delivery schedule is not sorted by Day: ${b.route_label} (${b.pp_name}) comes after ${a.route_label}.`);
      break;
    }
  }

  // Cross-check the totals row against the column sums
  if (totals) {
    const check = (label, i, sum) => {
      const t = String(totals[i] || '').trim();
      if (t && Number(t) !== sum) warn(`Delivery schedule totals row says ${t} for ${label}, but the stops add up to ${sum}.`);
    };
    check('Ballot Boxes', iBoxes, rows.reduce((n, r) => n + r.ballot_boxes, 0));
    supplyCols.forEach(c => check(c.label, c.i, rows.reduce((n, r) => n + ((r.supplies.find(s => s.key === c.key) || {}).qty || 0), 0)));
  }
  return rows;
}

// Build one entry per physical building from the three exports
function buildManifest(machineRows, precinctRows, scheduleRows, warn = () => {}) {
  const first = (k) => (machineRows.find(r => r[k]) || {})[k] || '';
  const doe = first('DOE');
  const dm = doe.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const electionDate = dm ? `${dm[3]}-${dm[1].padStart(2, '0')}-${dm[2].padStart(2, '0')}` : doe;
  if (!dm) throw new Error('machine_data.csv: missing or invalid DOE (election date)');
  const election = {
    election_id: electionDate.slice(0, 7),
    election_name: first('ElectionName') || 'Election',
    election_date: electionDate
  };

  const NO_ROUTE = { day: null, stop: null, label: '', index: 9999 };
  const buildings = new Map();
  const byCpn = new Map();
  const byName = new Map();
  precinctRows.forEach(p => {
    const key = slugify(p.building + '|' + p.address);
    if (!buildings.has(key)) {
      buildings.set(key, Object.assign({}, election, {
        location_key: key,
        location_name: titleCase(p.building),
        location_name_raw: p.building,
        address: p.address,
        precincts: [],
        machines: [],
        route: NO_ROUTE, supplies: [], ballot_boxes: 0, contacts: [], schedule_pp_ids: []
      }));
    }
    const b = buildings.get(key);
    b.precincts.push({ num: p.num, name: titleCase(p.name) });
    byCpn.set(p.num, b);
    byName.set(p.name.toUpperCase(), b);
  });

  const unassigned = [];
  const byPp = new Map();   // machine "Polling Place" (uppercased) -> Set of buildings
  machineRows.forEach(m => {
    const lid = m['Ballot box lid SN'];
    if (!lid) return;
    const entry = {
      cpn: m['CPN'], precinct: m['Precinct'], machine: m['Machine'],
      serial: m['Serial Number'], lid_sn: lid, pp_name: m['Polling Place'] || ''
    };
    const b = (m['CPN'] && byCpn.get(m['CPN'])) || byName.get((m['Precinct'] || '').toUpperCase());
    if (b) {
      b.machines.push(entry);
      const k = entry.pp_name.toUpperCase();
      if (k) { if (!byPp.has(k)) byPp.set(k, new Set()); byPp.get(k).add(b); }
    } else { warn('Machine has no matching precinct: CPN ' + entry.cpn + ' ' + entry.precinct + ' ' + entry.machine); unassigned.push(entry); }
  });

  // Attach schedule rows to buildings
  const seenPrecinct = new Set();
  const rowsByBuilding = new Map();
  (scheduleRows || []).forEach(r => {
    const k = r.pp_name.toUpperCase();
    if (seenPrecinct.has(k)) warn(`Delivery schedule lists "${r.pp_name}" more than once.`);
    seenPrecinct.add(k);
    let b = null;
    const set = byPp.get(k);
    if (set && set.size) {
      b = [...set][0];
      if (set.size > 1) warn(`Delivery schedule row "${r.pp_name}" matches more than one building; used ${b.location_name}.`);
    } else {
      b = byName.get(k) || null;
    }
    if (!b) { warn(`Delivery schedule row "${r.pp_name}" (${r.route_label}) does not match any location.`); return; }
    if (!rowsByBuilding.has(b)) rowsByBuilding.set(b, []);
    rowsByBuilding.get(b).push(r);
  });

  rowsByBuilding.forEach((rows, b) => {
    rows.sort((x, y) => x.route_index - y.route_index);
    const head = rows[0];
    b.route = { day: head.day, stop: head.stop, label: head.route_label, index: head.route_index };
    const sums = new Map();
    rows.forEach(r => r.supplies.forEach(s => {
      const cur = sums.get(s.key);
      if (cur) cur.qty += s.qty; else sums.set(s.key, { ...s });
    }));
    b.supplies = [...sums.values()];
    b.ballot_boxes = rows.reduce((n, r) => n + r.ballot_boxes, 0);
    const seen = new Set();
    const contacts = [];
    rows.forEach(r => {
      if (rows.length > 1 && r.contacts.length) contacts.push('— ' + titleCase(r.pp_name));
      r.contacts.forEach(c => { if (!seen.has(c)) { seen.add(c); contacts.push(c); } });
    });
    b.contacts = contacts;
    b.schedule_pp_ids = [...new Set(rows.map(r => r.polling_place_id).filter(Boolean))];
    if (b.ballot_boxes !== b.machines.length) {
      warn(`Delivery schedule says ${b.ballot_boxes} ballot box(es) for ${b.location_name}, but the machine export has ${b.machines.length} seal(s).`);
    }
  });

  const result = Array.from(buildings.values());
  result.forEach(b => {
    if (!b.machines.length) warn('No machines for building: ' + b.location_name);
    if (!rowsByBuilding.has(b)) warn('No delivery schedule row for ' + b.location_name + '; it will be listed last.');
  });
  result.sort((a, b) => a.route.index - b.route.index || a.location_name.localeCompare(b.location_name));
  if (unassigned.length) {
    result.push(Object.assign({}, election, {
      location_key: 'unassigned-machines',
      location_name: 'Unassigned Machines',
      location_name_raw: 'UNASSIGNED MACHINES',
      address: '',
      precincts: [],
      machines: unassigned,
      route: NO_ROUTE, supplies: [], ballot_boxes: 0, contacts: [], schedule_pp_ids: []
    }));
  }
  return result;
}

module.exports = { normSeal, parseCSV, csvToObjects, parsePrecinctsCSV, parseScheduleCSV, titleCase, slugify, buildManifest };
