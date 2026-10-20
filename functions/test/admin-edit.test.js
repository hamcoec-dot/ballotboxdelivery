'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/manifest');
const d = require('../src/delivery');
const { PRECINCT_CSV, MACHINE_CSV } = require('./fixtures');

const manifest = m.buildManifest(m.csvToObjects(MACHINE_CSV), m.parsePrecinctsCSV(PRECINCT_CSV));
const loc = (name) => d.splitLocation(manifest.find(b => b.location_name === name));
const two = loc('Hall Two');   // ZZ1003, ZZ1004
const one = loc('Hall One');   // ZZ1001, ZZ1002
const admin = { email: 'admin@test' };
const NOW = '2027-03-09T12:00:00.000Z';
const scan = (...codes) => codes.map(code => ({ code, source: 'camera', at: 't0' }));

// A record as submitDelivery writes it
function record(location, scans, extra = {}) {
  const r = d.computeDelivery(location.pub.slots, location.expected.slots, scans);
  return {
    election_id: '2027-03', location_key: location.pub.location_key, location_name: location.pub.location_name,
    address: location.pub.address, precincts: location.pub.precincts,
    ...r, computed_status: r.match_status, status_overridden: false, edit_count: 0, notes: '', ...extra
  };
}
const ctxFor = (location, belongsTo = () => null) => ({ pub: location.pub, expectedSlots: location.expected.slots, belongsTo, admin, now: NOW });

test('computeDelivery keeps admin/unknown sources and returns scans[]', () => {
  const r = d.computeDelivery(two.pub.slots, two.expected.slots, [
    { code: 'ZZ1003', source: 'admin', at: 'x', added_by: 'a@b' }, { code: 'NOPE', source: 'unknown', at: null }, { code: 'ZZ1004', source: 'bogus' }
  ]);
  assert.deepEqual(r.scans.map(s => s.source), ['admin', 'unknown', 'manual']);
  assert.equal(r.unexpected_seals[0].source, 'unknown');
  assert.equal(r.scans[0].added_by, 'a@b');
});

test('notes-only edit changes nothing else and does not backfill status fields', () => {
  const rec = record(two, scan('ZZ1003', 'ZZ1004'));
  delete rec.computed_status; delete rec.status_overridden; // older record
  const r = d.applyAdminEdit(rec, { notes: 'fixed typo' }, ctxFor(two));
  assert.deepEqual(Object.keys(r.update), ['notes']);
  assert.deepEqual(r.before, { notes: '' });
  assert.deepEqual(r.after, { notes: 'fixed typo' });
});

test('adding a missing seal turns INCOMPLETE into MATCH; removing it goes back', () => {
  const rec = record(two, scan('ZZ1003'));
  assert.equal(rec.match_status, 'INCOMPLETE');
  const up = d.applyAdminEdit(rec, { scans: ['ZZ1003', 'zz1004'] }, ctxFor(two));
  assert.equal(up.update.match_status, 'MATCH');
  assert.equal(up.update.scanned_count, 2);
  const added = up.update.scans.find(s => s.code === 'zz1004');
  assert.equal(added.source, 'admin');
  assert.equal(added.added_by, 'admin@test');
  assert.equal(added.at, NOW);
  // existing code keeps driver provenance
  assert.deepEqual(up.update.scans.find(s => s.code === 'ZZ1003'), { code: 'ZZ1003', source: 'camera', at: 't0' });

  const back = d.applyAdminEdit({ ...rec, ...up.update }, { scans: ['ZZ1003'] }, ctxFor(two));
  assert.equal(back.update.match_status, 'INCOMPLETE');
});

test('location change copies labels from the new location and recomputes', () => {
  const rec = record(two, scan('ZZ1001', 'ZZ1002'));     // scanned Hall One seals at Hall Two -> MISMATCH
  assert.equal(rec.match_status, 'MISMATCH');
  const r = d.applyAdminEdit(rec, { locationKey: one.pub.location_key }, ctxFor(one));
  assert.equal(r.update.location_name, 'Hall One');
  assert.equal(r.update.address, one.pub.address);
  assert.equal(r.update.match_status, 'MATCH');
  assert.equal(r.update.unexpected_seals.length, 0);
  assert.equal(r.before.location_name, 'Hall Two');
});

test('status override persists across a scan edit; computed_status refreshes; Auto reverts', () => {
  const rec = record(two, scan('ZZ1003'));                // INCOMPLETE
  const o = d.applyAdminEdit(rec, { statusOverride: 'MATCH' }, ctxFor(two));
  assert.equal(o.update.match_status, 'MATCH');
  assert.equal(o.update.status_overridden, true);
  assert.equal(o.update.computed_status, undefined);      // unchanged: still INCOMPLETE
  const afterOverride = { ...rec, ...o.update };

  const e = d.applyAdminEdit(afterOverride, { scans: ['ZZ1003', 'ZZ1004', 'STRAY'] }, ctxFor(two));
  assert.equal(e.update.computed_status, 'MISMATCH');     // refreshed
  assert.equal(e.update.match_status, undefined);         // override kept (still MATCH)
  assert.equal(e.update.status_overridden, undefined);
  const afterEdit = { ...afterOverride, ...e.update };
  assert.equal(afterEdit.match_status, 'MATCH');

  const auto = d.applyAdminEdit(afterEdit, { statusOverride: null }, ctxFor(two));
  assert.equal(auto.update.match_status, 'MISMATCH');
  assert.equal(auto.update.status_overridden, false);
});

test('belongs_to is recorded for stray codes', () => {
  const rec = record(two, scan('ZZ1003'));
  const r = d.applyAdminEdit(rec, { scans: ['ZZ1003', 'ZZ1001'] }, ctxFor(two, c => (c === 'ZZ1001' ? 'hall-one' : null)));
  assert.equal(r.update.unexpected_seals[0].belongs_to, 'hall-one');
});

test('no-op patch is rejected', () => {
  const rec = record(two, scan('ZZ1003'));
  assert.throws(() => d.applyAdminEdit(rec, { notes: '' }, ctxFor(two)), e => e.code === 'invalid-argument');
  assert.throws(() => d.applyAdminEdit(rec, { scans: ['zz1003'] }, ctxFor(two)), e => e.code === 'invalid-argument'); // same code, different case
  assert.throws(() => d.applyAdminEdit(rec, { locationKey: rec.location_key }, ctxFor(two)), e => e.code === 'invalid-argument');
});

test('invalid status override is rejected', () => {
  const rec = record(two, scan('ZZ1003'));
  assert.throws(() => d.applyAdminEdit(rec, { statusOverride: 'FINE' }, ctxFor(two)), e => e.code === 'invalid-argument');
});

test('deleted records cannot be edited', () => {
  const rec = record(two, scan('ZZ1003'), { deleted: true });
  assert.throws(() => d.applyAdminEdit(rec, { notes: 'x' }, ctxFor(two)), e => e.code === 'failed-precondition');
});

test('legacy records (no seals[]) allow notes only', () => {
  const legacy = { election_id: '2027-03', location_name: 'Legacy', scanned_barcode: 'A1', expected_barcode: 'A1', match_status: 'MATCH', notes: '' };
  assert.equal(d.applyAdminEdit(legacy, { notes: 'n' }, ctxFor(two)).update.notes, 'n');
  for (const patch of [{ scans: ['A1'] }, { locationKey: 'x' }, { statusOverride: 'MATCH' }]) {
    assert.throws(() => d.applyAdminEdit(legacy, patch, ctxFor(two)), e => e.code === 'failed-precondition');
  }
});

test('reconstructScans rebuilds from scanned_barcode and unexpected_seals', () => {
  const rec = record(two, scan('ZZ1003', 'STRAY'));
  rec.unexpected_seals = [{ code: 'STRAY', source: 'manual', at: 't9', belongs_to: null }];
  delete rec.scans;
  assert.deepEqual(d.reconstructScans(rec), [
    { code: 'ZZ1003', source: 'unknown', at: null },
    { code: 'STRAY', source: 'manual', at: 't9' }
  ]);
});

test('editing a record without scans[] rebuilds then preserves driver provenance for strays', () => {
  const rec = record(two, scan('ZZ1003', 'STRAY'));
  delete rec.scans;
  rec.unexpected_seals = [{ code: 'STRAY', source: 'camera', at: 't9', belongs_to: null }];
  const r = d.applyAdminEdit(rec, { scans: ['ZZ1003', 'ZZ1004', 'STRAY'] }, ctxFor(two));
  assert.deepEqual(r.update.scans.map(s => [s.code, s.source]), [['ZZ1003', 'unknown'], ['ZZ1004', 'admin'], ['STRAY', 'camera']]);
});
