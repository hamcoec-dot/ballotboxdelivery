'use strict';
// Pure helpers (no Firebase imports) so they can be unit-tested.
const { normSeal } = require('./manifest');

const SOURCES = ['camera', 'manual', 'admin', 'unknown'];
const STATUSES = ['MATCH', 'INCOMPLETE', 'MISMATCH'];

const fail = (code, message) => Object.assign(new Error(message), { code });

// Split a manifest building into the client-readable doc (labels only) and the secret doc (lid SNs).
function splitLocation(building) {
  const slots = building.machines.map((m, i) => ({
    slot: i, cpn: m.cpn || '', precinct: m.precinct || '', machine: m.machine || '', serial: m.serial || ''
  }));
  return {
    key: building.location_key,
    pub: {
      location_key: building.location_key,
      location_name: building.location_name,
      address: building.address,
      precincts: building.precincts,
      slots,
      seal_count: slots.length
    },
    expected: {
      slots: building.machines.map((m, i) => ({ slot: i, lid_sn: normSeal(m.lid_sn) }))
    }
  };
}

// Which of the location's slots does `code` satisfy? Returns slot number or -1.
function matchSlot(expectedSlots, code) {
  const key = normSeal(code);
  if (!key) return -1;
  const hit = expectedSlots.find(s => s.lid_sn === key);
  return hit ? hit.slot : -1;
}

// Compute the delivery result. `scans` = [{code, source, at, added_by?}], `belongsTo(code)` -> locKey|null.
function computeDelivery(pubSlots, expectedSlots, scans, belongsTo = () => null) {
  const seen = new Set();
  const uniq = [];
  for (const s of scans) {
    const key = normSeal(s.code);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const entry = { code: String(s.code).trim(), source: SOURCES.includes(s.source) ? s.source : 'manual', at: s.at || null };
    if (s.added_by) entry.added_by = s.added_by;
    uniq.push(entry);
  }
  const scannedSlots = new Set();
  const unexpected = [];
  for (const s of uniq) {
    const slot = matchSlot(expectedSlots, s.code);
    if (slot >= 0) scannedSlots.add(slot);
    else {
      const u = { code: s.code, source: s.source, at: s.at, belongs_to: belongsTo(s.code) };
      if (s.added_by) u.added_by = s.added_by;
      unexpected.push(u);
    }
  }
  const seals = pubSlots.map(p => ({
    slot: p.slot, cpn: p.cpn, precinct: p.precinct, machine: p.machine, serial: p.serial,
    expected: (expectedSlots.find(e => e.slot === p.slot) || {}).lid_sn || '',
    scanned: scannedSlots.has(p.slot)
  }));
  const scannedCount = seals.filter(s => s.scanned).length;
  const status = unexpected.length ? 'MISMATCH' : (scannedCount < seals.length ? 'INCOMPLETE' : 'MATCH');
  return {
    scans: uniq,
    seals, unexpected_seals: unexpected,
    expected_count: seals.length, scanned_count: scannedCount,
    scanned_barcode: uniq.map(s => s.code).join('|'),
    expected_barcode: seals.map(s => s.expected).join('|'),
    match_status: status
  };
}

// The scans of an existing record. Records written before scans[] existed are rebuilt from
// scanned_barcode plus unexpected_seals (which kept their source/time); matched codes lose theirs.
function reconstructScans(existing) {
  if (Array.isArray(existing.scans)) return existing.scans.map(s => ({ ...s }));
  const unexpected = new Map((existing.unexpected_seals || []).map(u => [normSeal(u.code), u]));
  return String(existing.scanned_barcode || '').split('|').map(c => c.trim()).filter(Boolean).map(code => {
    const u = unexpected.get(normSeal(code));
    return u
      ? { code, source: SOURCES.includes(u.source) ? u.source : 'unknown', at: u.at || null }
      : { code, source: 'unknown', at: null };
  });
}

// Merge an admin-supplied list of codes with the existing scans: codes already present keep their
// original source/time, new codes are tagged as admin-added.
function mergeScans(existing, codes, admin, now) {
  const current = new Map(reconstructScans(existing).map(s => [normSeal(s.code), s]));
  const out = [];
  const seen = new Set();
  for (const raw of codes) {
    const code = String(raw).trim();
    const key = normSeal(code);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(current.get(key) || { code, source: 'admin', at: now, added_by: admin.email });
  }
  return out;
}

const sameKeys = (a, b) => {
  const ka = new Set(a.map(s => normSeal(s.code))), kb = new Set(b.map(s => normSeal(s.code)));
  return ka.size === kb.size && [...ka].every(k => kb.has(k));
};

// Apply an admin patch to an existing delivery record.
//   patch: { locationKey?, scans?: string[], notes?, statusOverride?: 'MATCH'|'INCOMPLETE'|'MISMATCH'|null }
//   ctx:   { pub, expectedSlots, belongsTo, admin: {email}, now }  (pub/expectedSlots = the TARGET location)
// Returns { update, before, after }. Throws errors carrying a Firebase-style `.code`.
function applyAdminEdit(existing, patch, ctx) {
  if (existing.deleted) throw fail('failed-precondition', 'Record is deleted; restore it first.');
  const legacy = !Array.isArray(existing.seals);
  if (legacy && (patch.locationKey !== undefined || patch.scans !== undefined || patch.statusOverride !== undefined)) {
    throw fail('failed-precondition', 'Legacy record: only notes can be edited.');
  }
  if (patch.statusOverride !== undefined && patch.statusOverride !== null && !STATUSES.includes(patch.statusOverride)) {
    throw fail('invalid-argument', 'Invalid status override.');
  }

  const update = {}, before = {}, after = {};
  const set = (k, v) => {
    if (JSON.stringify(existing[k] ?? null) === JSON.stringify(v ?? null)) return;
    before[k] = existing[k] ?? null;
    after[k] = v ?? null;
    update[k] = v;
  };

  if (patch.notes !== undefined) set('notes', patch.notes);

  if (!legacy) {
    const locationChanged = patch.locationKey !== undefined && patch.locationKey !== existing.location_key;
    const currentScans = reconstructScans(existing);
    const nextScans = patch.scans !== undefined ? mergeScans(existing, patch.scans, ctx.admin, ctx.now) : currentScans;
    const scansChanged = patch.scans !== undefined && !sameKeys(currentScans, nextScans);

    let computed = existing.computed_status || existing.match_status;
    const recompute = locationChanged || scansChanged;
    if (recompute) {
      const r = computeDelivery(ctx.pub.slots, ctx.expectedSlots, nextScans, ctx.belongsTo);
      if (locationChanged) {
        set('location_key', ctx.pub.location_key);
        set('location_name', ctx.pub.location_name);
        set('address', ctx.pub.address);
        set('precincts', ctx.pub.precincts);
      }
      set('scans', r.scans);
      set('seals', r.seals);
      set('unexpected_seals', r.unexpected_seals);
      set('expected_count', r.expected_count);
      set('scanned_count', r.scanned_count);
      set('scanned_barcode', r.scanned_barcode);
      set('expected_barcode', r.expected_barcode);
      computed = r.match_status;
    }

    // An override persists across scan/location edits until the admin explicitly picks Auto (null).
    if (recompute || patch.statusOverride !== undefined) {
      const override = patch.statusOverride !== undefined
        ? patch.statusOverride
        : (existing.status_overridden ? existing.match_status : null);
      set('computed_status', computed);
      set('status_overridden', !!override);
      set('match_status', override || computed);
    }
  }

  if (!Object.keys(update).length) throw fail('invalid-argument', 'No changes to save.');
  return { update, before, after };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

module.exports = {
  splitLocation, matchSlot, computeDelivery, reconstructScans, mergeScans, applyAdminEdit,
  UUID_RE, SOURCES, STATUSES
};
