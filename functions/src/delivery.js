'use strict';
// Pure helpers (no Firebase imports) so they can be unit-tested.
const { normSeal } = require('./manifest');

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

// Compute the delivery result. `scans` = [{code, source, at}], `belongsTo(code)` -> locKey|null.
function computeDelivery(pubSlots, expectedSlots, scans, belongsTo = () => null) {
  const seen = new Set();
  const uniq = [];
  for (const s of scans) {
    const key = normSeal(s.code);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniq.push({ code: String(s.code).trim(), source: s.source === 'camera' ? 'camera' : 'manual', at: s.at || null });
  }
  const scannedSlots = new Set();
  const unexpected = [];
  for (const s of uniq) {
    const slot = matchSlot(expectedSlots, s.code);
    if (slot >= 0) scannedSlots.add(slot);
    else unexpected.push({ code: s.code, source: s.source, at: s.at, belongs_to: belongsTo(s.code) });
  }
  const seals = pubSlots.map(p => ({
    slot: p.slot, cpn: p.cpn, precinct: p.precinct, machine: p.machine, serial: p.serial,
    expected: (expectedSlots.find(e => e.slot === p.slot) || {}).lid_sn || '',
    scanned: scannedSlots.has(p.slot)
  }));
  const scannedCount = seals.filter(s => s.scanned).length;
  const status = unexpected.length ? 'MISMATCH' : (scannedCount < seals.length ? 'INCOMPLETE' : 'MATCH');
  return {
    seals, unexpected_seals: unexpected,
    expected_count: seals.length, scanned_count: scannedCount,
    scanned_barcode: uniq.map(s => s.code).join('|'),
    expected_barcode: seals.map(s => s.expected).join('|'),
    match_status: status
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

module.exports = { splitLocation, matchSlot, computeDelivery, UUID_RE };
