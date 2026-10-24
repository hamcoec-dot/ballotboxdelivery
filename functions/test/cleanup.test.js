'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/cleanup');

test('localDate uses Eastern time, not UTC', () => {
  // 02:00 UTC on Nov 3 is still Nov 2 in Chattanooga
  assert.equal(c.localDate(new Date('2027-11-03T02:00:00Z')), '2027-11-02');
  assert.equal(c.localDate(new Date('2027-11-03T05:00:00Z')), '2027-11-03');
});

test('clearBlockedReason allows clearing only before election day', () => {
  assert.equal(c.clearBlockedReason('2027-11-03', new Date('2027-10-24T15:00:00Z')), null);
  assert.equal(c.clearBlockedReason('2027-11-03', new Date('2027-11-03T02:00:00Z')), null); // Nov 2, 10pm Eastern
  assert.match(c.clearBlockedReason('2027-11-03', new Date('2027-11-03T05:00:00Z')), /Election day/);
  assert.match(c.clearBlockedReason('2027-11-03', new Date('2028-01-01T00:00:00Z')), /arrived or passed/);
});

test('clearBlockedReason refuses an election with no usable date', () => {
  assert.match(c.clearBlockedReason(undefined, new Date()), /no valid date/);
  assert.match(c.clearBlockedReason('11/3/2027', new Date()), /no valid date/);
});

test('recordedBeforeClear flags only submissions whose every scan predates the clear', () => {
  const cleared = Date.parse('2027-10-25T12:00:00Z');
  const at = (iso) => ({ code: 'ZZ1', at: iso });
  assert.equal(c.recordedBeforeClear([at('2027-10-24T09:00:00Z'), at('2027-10-24T09:01:00Z')], cleared), true);
  assert.equal(c.recordedBeforeClear([at('2027-10-24T09:00:00Z'), at('2027-10-26T09:00:00Z')], cleared), false);
  assert.equal(c.recordedBeforeClear([at('2027-10-26T09:00:00Z')], cleared), false);
});

test('recordedBeforeClear records the delivery when it cannot tell', () => {
  const cleared = Date.parse('2027-10-25T12:00:00Z');
  assert.equal(c.recordedBeforeClear([{ code: 'ZZ1', at: null }], cleared), false);
  assert.equal(c.recordedBeforeClear([{ code: 'ZZ1', at: 'garbage' }], cleared), false);
  assert.equal(c.recordedBeforeClear([], cleared), false);
  assert.equal(c.recordedBeforeClear([{ code: 'ZZ1', at: '2027-10-24T09:00:00Z' }], NaN), false);
});
