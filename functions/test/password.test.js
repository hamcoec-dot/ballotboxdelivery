'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { appResetUrl, passwordEmailText, normEmail, isEmail, tooSoon, RESEND_MS } = require('../src/password');

test('appResetUrl swaps the Firebase hosted page for our own', () => {
  const fb = 'https://ballotboxdelivery.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=AbC-123_x%3D&apiKey=k&lang=en';
  const u = new URL(appResetUrl(fb));
  assert.strictEqual(u.origin + u.pathname, 'https://govotehamiltontn.gov/ballotboxdelivery/');
  assert.strictEqual(u.searchParams.get('mode'), 'resetPassword');
  assert.strictEqual(u.searchParams.get('oobCode'), 'AbC-123_x=');
  assert.strictEqual(u.searchParams.get('apiKey'), null);
  assert.ok(!u.toString().includes('firebaseapp.com'));
});

test('appResetUrl refuses a link without a code', () => {
  assert.throws(() => appResetUrl('https://example.com/?mode=resetPassword'));
});

test('email text names the account and the link, and never firebaseapp.com', () => {
  for (const byAdmin of [true, false]) {
    const m = passwordEmailText('d@x.gov', 'https://govotehamiltontn.gov/ballotboxdelivery/?mode=resetPassword&oobCode=z', byAdmin);
    assert.ok(m.text.includes('d@x.gov'));
    assert.ok(m.text.includes('oobCode=z'));
    assert.ok(!m.text.includes('firebaseapp'));
  }
});

test('email helpers', () => {
  assert.strictEqual(normEmail('  Driver@HamiltonTN.gov '), 'driver@hamiltontn.gov');
  assert.ok(isEmail('a@b.gov'));
  assert.ok(!isEmail('nope'));
  assert.ok(!isEmail(''));
  const now = 1e12;
  assert.ok(tooSoon(now - 1000, now));
  assert.ok(!tooSoon(now - RESEND_MS, now));
  assert.ok(!tooSoon(undefined, now));
});
