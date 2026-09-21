/* Unit tests for the desktop shell's pure logic.
   Run with: npm test   (no display needed) */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isAllowedUrl, daysUntil, dueReminders, pruneNotified } = require('../lib.js');

const TODAY = new Date(2026, 8, 19);           // 2026-09-19, local time
const plus = (days) => {
  const d = new Date(TODAY);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

test('navigation stays inside the app and PayPal', () => {
  assert.equal(isAllowedUrl('https://domain-vault.elnegocio.digital/admin.html'), true);
  assert.equal(isAllowedUrl('https://www.paypal.com/checkout'), true);
  assert.equal(isAllowedUrl('http://127.0.0.1:5500/index.html'), true, 'local dev');
});

test('navigation to anywhere else is refused', () => {
  for (const url of [
    'https://evil.example/phish',
    'https://domain-vault.elnegocio.digital.evil.example',   // suffix trick
    'file:///etc/passwd',
    'javascript:alert(1)',
    'http://192.168.1.10/admin',                             // non-local plain http
    'not a url',
    '',
  ]) {
    assert.equal(isAllowedUrl(url), false, url);
  }
});

test('daysUntil counts whole days and rejects junk', () => {
  assert.equal(daysUntil(plus(0), TODAY), 0);
  assert.equal(daysUntil(plus(7), TODAY), 7);
  assert.equal(daysUntil(plus(-3), TODAY), -3);
  assert.equal(daysUntil('', TODAY), null);
  assert.equal(daysUntil('tomorrow', TODAY), null);
  assert.equal(daysUntil(undefined, TODAY), null);
});

test('only 30/7/1-day renewals raise a notification', () => {
  const domains = [
    { name: 'thirty.com', renewalDate: plus(30) },
    { name: 'seven.com', renewalDate: plus(7) },
    { name: 'tomorrow.com', renewalDate: plus(1) },
    { name: 'far-away.com', renewalDate: plus(45) },
    { name: 'soon-but-not-today.com', renewalDate: plus(12) },
    { name: 'expired.com', renewalDate: plus(-5) },
    { name: 'no-date.com', renewalDate: '' },
  ];
  const due = dueReminders(domains, { today: TODAY });
  assert.deepEqual(due.map((d) => d.name), ['tomorrow.com', 'seven.com', 'thirty.com'], 'soonest first');
  assert.equal(due[0].title, 'Domain expires tomorrow');
  assert.equal(due[2].title, 'Domain expires in 30 days');
});

test('the same reminder is never raised twice', () => {
  const domains = [{ name: 'seven.com', renewalDate: plus(7) }];
  const first = dueReminders(domains, { today: TODAY });
  assert.equal(first.length, 1);
  const second = dueReminders(domains, { today: TODAY, alreadyNotified: first.map((d) => d.key) });
  assert.equal(second.length, 0, 'already notified');
});

test('a later milestone for the same domain still notifies', () => {
  const domains = [{ name: 'seven.com', renewalDate: plus(1) }];
  const due = dueReminders(domains, { today: TODAY, alreadyNotified: ['seven.com:7', 'seven.com:30'] });
  assert.equal(due.length, 1);
  assert.equal(due[0].days, 1);
});

test('bad input never throws', () => {
  assert.deepEqual(dueReminders(null, { today: TODAY }), []);
  assert.deepEqual(dueReminders([null, 42, {}, { name: 'x' }], { today: TODAY }), []);
});

test('stored reminder keys are pruned once a renewal passes', () => {
  const domains = [{ name: 'seven.com', renewalDate: plus(7) }];
  const kept = pruneNotified(['seven.com:7', 'gone.com:1', 'seven.com:30'], domains, TODAY);
  assert.deepEqual(kept, ['seven.com:7'], 'only keys matching a live renewal survive');
});
