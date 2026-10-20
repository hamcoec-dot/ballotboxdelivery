'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/manifest');
const d = require('../src/delivery');
const { PRECINCT_HEADER, prow, MACHINE_HEADER, mrow } = require('./fixtures');

// SYNTHETIC delivery schedule that reproduces the quirks of the real export.
const SCHED_HEADER = 'Precinct,Seal Number at Delivery,Day,Echelon Filter,Polling Place ID,Polling Place,Ballot Boxes,Vote Here Signs,Tables,Polling Place  Direction Sign,Adjust Row Hight in Points,Equipment,Contact';
const srow = (precinct, day, ppId, place, boxes, signs, tables, dirSign, equip, contact) =>
  `${precinct},,${day},,${ppId},"${place}",${boxes},${signs},${tables},${dirSign},15,"${equip}","${contact}"`;

const SCHEDULE = [
  SCHED_HEADER,
  srow('ALPHA A & B', '1.01', 501, 'Hall One\n1 Test St\nTestville', 2, 1, 6, '', 'Vote Here Sandwich Boards: 1\nTables: 6', 'JANE DOE|(555) 123-4567|Door Code 1234#|He said ""hi""'),
  srow('BETA', '1.02', 502, 'Hall Two\n2 Test St\nTestville', 2, '', 4, 1, 'Tables: 4', 'BOB|(555) 987-6543|(555) 987-6543'),
  srow('GAMMA B', '3.30', 503, 'Hall Three\n3 Test St\nTestville', 1, 2, 0, '', '', ''),
  ',,,,,,5,3,10,1,,,'    // totals row (blank Day)
].join('\r\n') + '\r\n';

const PRECINCTS = [
  PRECINCT_HEADER,
  prow(1, 'ALPHA A', 'HALL ONE', '1 TEST ST, TESTVILLE TN 37000', 'PO BOX 1, TESTVILLE TN 37001'),
  prow(2, 'ALPHA B', 'HALL ONE', '1 TEST ST, TESTVILLE TN 37000', 'PO BOX 1, TESTVILLE TN 37001'),
  prow(3, 'BETA', 'HALL TWO', '2 TEST ST, TESTVILLE TN 37000', 'PO BOX 2, TESTVILLE TN 37001'),
  prow(4, 'GAMMA B', 'HALL THREE', '3 TEST ST, TESTVILLE TN 37000', 'PO BOX 3, TESTVILLE TN 37001')
].join('\n');

const MACHINES = [
  MACHINE_HEADER,
  mrow(1, 'Alpha A', '', 'DS-1', 'ZZ1001', undefined, undefined, 'Alpha A & B'),
  mrow(2, 'Alpha B', '', 'DS-2', 'ZZ1002', undefined, undefined, 'Alpha A & B'),
  mrow(3, 'Beta', '1', 'DS-3', 'ZZ1003'),
  mrow(3, 'Beta', '2', 'DS-4', 'ZZ1004'),
  mrow(4, 'Gamma B', '', 'DS-5', 'ZZ1005')
].join('\n');

const run = (sched = SCHEDULE, machines = MACHINES, precincts = PRECINCTS) => {
  const warnings = [];
  const rows = m.parseScheduleCSV(sched, w => warnings.push(w));
  const b = m.buildManifest(m.csvToObjects(machines), m.parsePrecinctsCSV(precincts), rows, w => warnings.push(w));
  return { rows, b, warnings, byName: Object.fromEntries(b.map(x => [x.location_name, x])) };
};

test('parseScheduleCSV: multi-line quoted fields, totals row skipped, string stops, dynamic supply columns', () => {
  const warnings = [];
  const rows = m.parseScheduleCSV(SCHEDULE, w => warnings.push(w));
  assert.equal(rows.length, 3);                                   // totals row skipped
  assert.deepEqual(rows.map(r => r.route_label), ['1.01', '1.02', '3.30']);
  assert.deepEqual([rows[2].day, rows[2].stop], [3, '30']);       // "30", not 3
  assert.deepEqual(rows[0].supplies.map(s => [s.key, s.qty]), [['vote-here-signs', 1], ['tables', 6]]);
  assert.deepEqual(rows[1].supplies.map(s => s.key), ['tables', 'polling-place-direction-sign']); // double-space header collapsed
  assert.equal(rows[2].supplies.length, 1);                        // Tables 0 dropped, Vote Here 2 kept
  assert.deepEqual(warnings, []);                                  // totals 5/3/10/1 match
});

test('parseScheduleCSV: contacts split on | with quotes unescaped', () => {
  const rows = m.parseScheduleCSV(SCHEDULE);
  assert.deepEqual(rows[0].contacts, ['JANE DOE', '(555) 123-4567', 'Door Code 1234#', 'He said "hi"']);
  assert.deepEqual(rows[2].contacts, []);
});

test('parseScheduleCSV: totals cross-check, bad quantity, short stop and unsorted file warn', () => {
  const warnings = [];
  const bad = SCHEDULE.replace(',,,,,,5,3,10,1,,,', ',,,,,,6,3,10,1,,,')
    .replace('1.02', '1.2').replace(',4,1,', ',x,1,');
  m.parseScheduleCSV(bad, w => warnings.push(w));
  assert.ok(warnings.some(w => /totals row says 6 for Ballot Boxes/.test(w)));
  assert.ok(warnings.some(w => /not a valid quantity/.test(w)));
  assert.ok(warnings.some(w => /one digit after the dot/.test(w)));
  const w2 = [];
  m.parseScheduleCSV(SCHEDULE.replace('1.01', '2.01'), w => w2.push(w));
  assert.ok(w2.some(w => /not sorted by Day/.test(w)));
});

test('parseScheduleCSV: rejects a file without the expected header', () => {
  assert.throws(() => m.parseScheduleCSV('a,b\n1,2'), /unexpected header/);
  assert.throws(() => m.parseScheduleCSV(''), /empty/);
});

test('buildManifest: route, supplies, contacts and sort order come from the schedule', () => {
  const { b, byName, warnings } = run();
  assert.deepEqual(b.map(x => x.route.label), ['1.01', '1.02', '3.30']);   // route order, not alphabetical
  assert.equal(byName['Hall One'].route.index, 0);
  assert.deepEqual(byName['Hall Two'].supplies.map(s => [s.label, s.qty]), [['Tables', 4], ['Polling Place Direction Sign', 1]]);
  assert.deepEqual(warnings, []);                                          // ballot boxes == seals everywhere
  assert.deepEqual(byName['Hall One'].schedule_pp_ids, ['501']);
});

test('buildManifest: shared building merges rows (supplies summed, contacts merged, min route)', () => {
  const sched = [
    SCHED_HEADER,
    srow('BETA', '1.02', 502, 'Hall Two\n2 Test St', 2, '', 4, '', '', 'BOB'),
    srow('ALPHA A', '2.04', 601, 'Hall One\n1 Test St', 1, 1, 3, '', '', 'JANE|(555) 111-2222'),
    srow('ALPHA B', '2.05', 601, 'Hall One\n1 Test St', 1, 2, 2, '', '', 'JANE|SUE')
  ].join('\n');
  const machines = [MACHINE_HEADER,
    mrow(1, 'Alpha A', '', 'DS-1', 'ZZ1001'), mrow(2, 'Alpha B', '', 'DS-2', 'ZZ1002'),
    mrow(3, 'Beta', '1', 'DS-3', 'ZZ1003'), mrow(3, 'Beta', '2', 'DS-4', 'ZZ1004')].join('\n');
  const { byName, b, warnings } = run(sched, machines);
  const hall = byName['Hall One'];
  assert.equal(hall.route.label, '2.04');                                  // first row's label (min index among its rows)
  assert.deepEqual(hall.supplies.map(s => [s.key, s.qty]), [['vote-here-signs', 3], ['tables', 5]]);
  assert.deepEqual(hall.contacts, ['— Alpha A', 'JANE', '(555) 111-2222', '— Alpha B', 'SUE']); // JANE de-duplicated
  assert.equal(hall.ballot_boxes, 2);
  assert.deepEqual(b.map(x => x.location_name), ['Hall Two', 'Hall One', 'Hall Three']); // Hall Three has no row: last
  assert.ok(warnings.some(w => /No delivery schedule row for Hall Three/.test(w)));
});

test('buildManifest: warns on unmatched schedule rows, ballot-box mismatch and duplicate rows', () => {
  const sched = [
    SCHED_HEADER,
    srow('ALPHA A & B', '1.01', 501, 'Hall One\n1 Test St', 3, 1, 6, '', '', ''),   // 3 boxes but 2 seals
    srow('GHOST PLACE', '1.02', 999, 'Nowhere\n9 St', 1, '', '', '', '', ''),
    srow('ALPHA A & B', '1.03', 501, 'Hall One\n1 Test St', 0, '', '', '', '', '')
  ].join('\n');
  const { warnings } = run(sched);
  assert.ok(warnings.some(w => /GHOST PLACE.*does not match any location/.test(w)));
  assert.ok(warnings.some(w => /3 ballot box\(es\) for Hall One, but the machine export has 2/.test(w)));
  assert.ok(warnings.some(w => /more than once/.test(w)));
});

test('buildManifest: falls back to the precinct name when the machine export has no Polling Place', () => {
  const machines = [MACHINE_HEADER.replace(',Polling Place', ''),
    ...MACHINES.split('\n').slice(1).map(r => r.split(',').slice(0, -1).join(','))].join('\n');
  const sched = [SCHED_HEADER, srow('BETA', '1.01', 502, 'Hall Two\n2 Test St', 2, '', 4, '', '', 'BOB')].join('\n');
  const { byName } = run(sched, machines);
  assert.equal(byName['Hall Two'].route.label, '1.01');
});

test('splitLocation exposes schedule data on the public doc only (no seal numbers)', () => {
  const { b } = run();
  const loc = d.splitLocation(b[0]);
  assert.equal(loc.pub.route.label, '1.01');
  assert.ok(loc.pub.supplies.length && loc.pub.contacts.length);
  assert.ok(!JSON.stringify(loc.pub).includes('ZZ100'));
});

// ---- computeSupplies ----
const PUB = [{ key: 'tables', label: 'Tables', qty: 6 }, { key: 'cones', label: 'Traffic Cones', qty: 4 }];

test('computeSupplies: delivered, partial qty, clamping, unknown keys, missing keys', () => {
  const r = d.computeSupplies(PUB, [
    { key: 'tables', delivered: true },
    { key: 'cones', delivered: false, qty: 99 },     // clamped to 4 -> counts as delivered
    { key: 'bogus', delivered: true, qty: 5 }          // ignored
  ]);
  assert.deepEqual(r.supplies.map(s => [s.key, s.expected, s.delivered_qty, s.delivered]), [['tables', 6, 6, true], ['cones', 4, 4, true]]);
  assert.equal(r.supplies_status, 'COMPLETE');

  const s = d.computeSupplies(PUB, [{ key: 'tables', delivered: false, qty: 2 }]);   // cones missing -> not delivered
  assert.deepEqual(s.supplies.map(x => [x.delivered_qty, x.delivered]), [[2, false], [0, false]]);
  assert.equal(s.supplies_status, 'SHORT');
  assert.equal(d.computeSupplies(PUB, [{ key: 'tables', delivered: false, qty: -5 }, { key: 'cones', delivered: true }]).supplies[0].delivered_qty, 0);
});

test('computeSupplies: no supplies at a location is COMPLETE; submitting nothing is SHORT when there are some', () => {
  assert.deepEqual(d.computeSupplies([], []), { supplies: [], supplies_status: 'COMPLETE' });
  assert.equal(d.computeSupplies(PUB, undefined).supplies_status, 'SHORT');
  assert.equal(d.computeSupplies(PUB, 'junk').supplies_status, 'SHORT');
});

test('applyAdminEdit: supplies patch recomputes with the same helper; no-op rejected; legacy refused', () => {
  const { b } = run();
  const loc = d.splitLocation(b[0]);          // Hall One: Vote Here 1, Tables 6
  const rec = {
    election_id: '2027-03', location_key: loc.pub.location_key, seals: [], scans: [], unexpected_seals: [], match_status: 'INCOMPLETE',
    computed_status: 'INCOMPLETE', status_overridden: false, notes: '', edit_count: 0,
    ...d.computeSupplies(loc.pub.supplies, loc.pub.supplies.map(x => ({ key: x.key, delivered: true })))   // COMPLETE
  };
  assert.equal(rec.supplies_status, 'COMPLETE');
  const ctx = { pub: loc.pub, expectedSlots: loc.expected.slots, belongsTo: () => null, admin: { email: 'a@b' }, now: 'now' };
  const r = d.applyAdminEdit(rec, { supplies: [{ key: 'vote-here-signs', delivered: true }, { key: 'tables', delivered: false, qty: 3 }] }, ctx);
  assert.equal(r.update.supplies_status, 'SHORT');
  assert.deepEqual(r.update.supplies.map(s => s.delivered_qty), [1, 3]);
  assert.throws(() => d.applyAdminEdit(rec, { supplies: loc.pub.supplies.map(x => ({ key: x.key, delivered: true })) }, ctx), e => e.code === 'invalid-argument');   // same as stored
  assert.throws(() => d.applyAdminEdit({ election_id: 'x', match_status: 'MATCH' }, { supplies: [] }, ctx), e => e.code === 'failed-precondition');
});
