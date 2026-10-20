'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/manifest');
const d = require('../src/delivery');
const { PRECINCT_CSV, MACHINE_CSV } = require('./fixtures');

const manifest = m.buildManifest(m.csvToObjects(MACHINE_CSV), m.parsePrecinctsCSV(PRECINCT_CSV));
const two = d.splitLocation(manifest.find(b => b.location_name === 'Hall Two')); // ZZ1003, ZZ1004
const scan = (...codes) => codes.map(code => ({ code, source: 'manual', at: 't' }));

test('splitLocation: public doc has no seal numbers, expected doc is normalized', () => {
  assert.ok(!JSON.stringify(two.pub).includes('ZZ100'));
  assert.deepEqual(two.expected.slots.map(s => s.lid_sn), ['ZZ1003', 'ZZ1004']); // lowercase source normalized
  assert.equal(two.pub.seal_count, 2);
});

test('matchSlot is trimmed and case-insensitive', () => {
  assert.equal(d.matchSlot(two.expected.slots, ' zz1003 '), 0);
  assert.equal(d.matchSlot(two.expected.slots, 'ZZ1004'), 1);
  assert.equal(d.matchSlot(two.expected.slots, 'nope'), -1);
  assert.equal(d.matchSlot(two.expected.slots, ''), -1);
});

test('status MATCH when every seal scanned', () => {
  const r = d.computeDelivery(two.pub.slots, two.expected.slots, scan('zz1003', 'ZZ1004'));
  assert.equal(r.match_status, 'MATCH');
  assert.equal(r.scanned_count, 2);
  assert.equal(r.expected_count, 2);
});

test('status INCOMPLETE when a seal is missing', () => {
  const r = d.computeDelivery(two.pub.slots, two.expected.slots, scan('ZZ1003'));
  assert.equal(r.match_status, 'INCOMPLETE');
  assert.deepEqual(r.seals.map(s => s.scanned), [true, false]);
});

test('status MISMATCH beats INCOMPLETE; unexpected carries belongs_to', () => {
  const r = d.computeDelivery(two.pub.slots, two.expected.slots, scan('ZZ1003', 'ZZ1001'), c => (c === 'ZZ1001' ? 'hall-one' : null));
  assert.equal(r.match_status, 'MISMATCH');
  assert.deepEqual(r.unexpected_seals.map(u => [u.code, u.belongs_to]), [['ZZ1001', 'hall-one']]);
});

test('duplicate and blank scans are collapsed; source is sanitized', () => {
  const r = d.computeDelivery(two.pub.slots, two.expected.slots, [
    { code: 'ZZ1003', source: 'camera' }, { code: ' zz1003', source: 'x' }, { code: '   ' }
  ]);
  assert.equal(r.scanned_barcode, 'ZZ1003');
  assert.equal(r.scanned_count, 1);
});

test('UUID_RE accepts v4 ids only in uuid shape', () => {
  assert.ok(d.UUID_RE.test('3b241101-e2bb-4255-8caf-4136c566a962'));
  assert.ok(!d.UUID_RE.test('not-a-uuid'));
  assert.ok(!d.UUID_RE.test('../../x'));
});
