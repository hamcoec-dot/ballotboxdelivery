'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/manifest');
const { PRECINCT_CSV, MACHINE_CSV, PRECINCT_HEADER, prow, mrow, MACHINE_HEADER } = require('./fixtures');

const build = (machine = MACHINE_CSV, precinct = PRECINCT_CSV, warnings = []) =>
  m.buildManifest(m.csvToObjects(machine), m.parsePrecinctsCSV(precinct, w => warnings.push(w)), w => warnings.push(w));

test('parseCSV handles BOM, CRLF, quotes, escapes, blank lines, multiline fields', () => {
  assert.deepEqual(m.parseCSV('﻿a,b\r\n"x, y","he said ""hi"""\r\n\r\n1,2'), [['a', 'b'], ['x, y', 'he said "hi"'], ['1', '2']]);
  assert.deepEqual(m.parseCSV('a,b\n"l1\nl2",z\n'), [['a', 'b'], ['l1\nl2', 'z']]);
});

test('parsePrecinctsCSV recovers addresses from unquoted commas', () => {
  const rows = m.parsePrecinctsCSV(PRECINCT_CSV);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].address, '1 TEST ST, TESTVILLE TN 37000');   // double space normalized, mailing excluded
  assert.equal(rows[3].address, '3 TEST ST, TESTVILLE TN 37000-1234'); // ZIP+4
  assert.equal(rows[0].building, 'HALL ONE');
});

test('parsePrecinctsCSV: no ZIP warns and falls back; bad header throws', () => {
  const warnings = [];
  const rows = m.parsePrecinctsCSV(PRECINCT_HEADER + '\n' + prow(9, 'NOZIP', 'HALL', '1 MAIN ST, NOWHERE', 'PO BOX 1, X'), w => warnings.push(w));
  assert.equal(rows[0].address, '1 MAIN ST, NOWHERE');
  assert.equal(warnings.length, 1);
  assert.throws(() => m.parsePrecinctsCSV('a,b\n1,2'), /unexpected header/);
});

test('buildManifest: one stop per building, shared building merges precincts and seals', () => {
  const warnings = [];
  const b = build(MACHINE_CSV, PRECINCT_CSV, warnings);
  const byName = Object.fromEntries(b.map(x => [x.location_name, x]));
  assert.equal(b.length, 4); // 4 buildings, no unassigned stop
  assert.deepEqual(byName['Hall One'].precincts.map(p => p.num), ['1', '2']);
  assert.deepEqual(byName['Hall One'].machines.map(x => x.lid_sn), ['ZZ1001', 'ZZ1002']);
  assert.equal(byName['Hall Two'].machines.length, 2);
  assert.equal(b[0].election_id, '2027-03');
  assert.equal(b[0].election_date, '2027-03-09');
});

test('buildManifest: blank-CPN machine joins by precinct name; blank lid and blank rows skipped', () => {
  const b = build();
  const three = b.find(x => x.location_name === 'Hall Three');
  assert.deepEqual(three.machines.map(x => x.lid_sn), ['ZZ1005']);
  assert.equal(b.reduce((n, x) => n + x.machines.length, 0), 5);
});

test('buildManifest: building with no machines is kept and warned', () => {
  const warnings = [];
  const b = build(MACHINE_CSV, PRECINCT_CSV, warnings);
  assert.equal(b.find(x => x.location_name === 'Hall Four').machines.length, 0);
  assert.ok(warnings.some(w => /Hall Four/.test(w)));
});

test('buildManifest: unmatched machine goes to Unassigned Machines stop', () => {
  const warnings = [];
  const csv = [MACHINE_HEADER, mrow(1, 'Alpha A', '', 'DS-1', 'ZZ1'), mrow(99, 'Ghost', '', 'DS-9', 'ZZ9')].join('\n');
  const b = build(csv, PRECINCT_CSV, warnings);
  const u = b.find(x => x.location_key === 'unassigned-machines');
  assert.deepEqual(u.machines.map(x => x.lid_sn), ['ZZ9']);
  assert.ok(warnings.some(w => /Ghost/.test(w)));
});

test('buildManifest: missing/invalid DOE throws', () => {
  const csv = [MACHINE_HEADER, mrow(1, 'Alpha A', '', 'DS-1', 'ZZ1', 'not-a-date')].join('\n');
  assert.throws(() => build(csv), /DOE/);
});
