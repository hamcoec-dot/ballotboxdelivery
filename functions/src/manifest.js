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

// Build one entry per physical building from the two exports
function buildManifest(machineRows, precinctRows, warn = () => {}) {
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
        machines: []
      }));
    }
    const b = buildings.get(key);
    b.precincts.push({ num: p.num, name: titleCase(p.name) });
    byCpn.set(p.num, b);
    byName.set(p.name.toUpperCase(), b);
  });

  const unassigned = [];
  machineRows.forEach(m => {
    const lid = m['Ballot box lid SN'];
    if (!lid) return;
    const entry = {
      cpn: m['CPN'], precinct: m['Precinct'], machine: m['Machine'],
      serial: m['Serial Number'], lid_sn: lid
    };
    const b = (m['CPN'] && byCpn.get(m['CPN'])) || byName.get((m['Precinct'] || '').toUpperCase());
    if (b) b.machines.push(entry);
    else { warn('Machine has no matching precinct: CPN ' + entry.cpn + ' ' + entry.precinct + ' ' + entry.machine); unassigned.push(entry); }
  });

  const result = Array.from(buildings.values());
  result.forEach(b => {
    if (!b.machines.length) warn('No machines for building: ' + b.location_name);
  });
  if (unassigned.length) {
    result.push(Object.assign({}, election, {
      location_key: 'unassigned-machines',
      location_name: 'Unassigned Machines',
      location_name_raw: 'UNASSIGNED MACHINES',
      address: '',
      precincts: [],
      machines: unassigned
    }));
  }
  return result;
}


module.exports = { normSeal, parseCSV, csvToObjects, parsePrecinctsCSV, titleCase, slugify, buildManifest };
