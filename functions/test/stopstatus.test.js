'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../src/stopstatus');

const ts = (ms) => ({ toMillis: () => ms });
const rec = (id, ms, extra = {}) => ({ id, data: { timestamp: ts(ms), driver_email: `${id}@govotehamiltontn.gov`, ...extra } });

test('shortName keeps the part before the @', () => {
  assert.equal(s.shortName('jsmith@govotehamiltontn.gov'), 'jsmith');
  assert.equal(s.shortName(''), 'another driver');
  assert.equal(s.shortName(undefined), 'another driver');
});

test('deliveredFields picks the newest live delivery', () => {
  const f = s.deliveredFields([rec('amy', 100), rec('bob', 300), rec('cal', 200)]);
  assert.equal(f.delivery_id, 'bob');
  assert.equal(f.delivered_by, 'bob');
  assert.equal(f.delivered_at.toMillis(), 300);
});

test('deliveredFields skips soft-deleted records and returns null when none are live', () => {
  assert.equal(s.deliveredFields([rec('amy', 100), rec('bob', 300, { deleted: true })]).delivery_id, 'amy');
  assert.equal(s.deliveredFields([rec('bob', 300, { deleted: true })]), null);
  assert.equal(s.deliveredFields([]), null);
});

test('deliveredFields copes with a missing timestamp', () => {
  const f = s.deliveredFields([{ id: 'x', data: { driver_email: 'x@y' } }]);
  assert.equal(f.delivery_id, 'x');
  assert.equal(f.delivered_at, null);
});

test('DELIVERED_FIELDS matches what deliveredFields writes', () => {
  assert.deepEqual(Object.keys(s.deliveredFields([rec('a', 1)])).sort(), [...s.DELIVERED_FIELDS].sort());
});
