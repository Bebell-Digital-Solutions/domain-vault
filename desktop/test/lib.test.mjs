/* Unit tests for the desktop shell's pure logic.
   Run with: npm test   (no display needed) */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isAllowedUrl, daysUntil, normalizePrefs, normalizeDomains, dueReminders, pruneNotified,
} = require('../lib.js');

const TODAY = new Date(2026, 8, 19);           // 2026-09-19, local time
const shift = (days, from = TODAY) => {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d;
};
// Local yyyy-mm-dd; toISOString() would be a day off east of UTC.
const iso = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate()]
  .map((n, i) => String(n).padStart(i ? 2 : 4, '0')).join('-');
const plus = (days) => iso(shift(days));

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

/* ------------------------------------------------------------- reminders */

test('renewals that have reached a milestone raise a notification', () => {
  const domains = [
    { name: 'thirty.com', renewalDate: plus(30) },
    { name: 'seven.com', renewalDate: plus(7) },
    { name: 'tomorrow.com', renewalDate: plus(1) },
    { name: 'today.com', renewalDate: plus(0) },
    { name: 'twelve.com', renewalDate: plus(12) },           // inside the 30-day window
    { name: 'far-away.com', renewalDate: plus(45) },
    { name: 'expired.com', renewalDate: plus(-5) },
    { name: 'no-date.com', renewalDate: '' },
  ];
  const due = dueReminders(domains, { today: TODAY });
  assert.deepEqual(due.map((d) => d.name),
    ['today.com', 'tomorrow.com', 'seven.com', 'twelve.com', 'thirty.com'], 'soonest first');
  assert.deepEqual(due.map((d) => d.milestone), [0, 1, 7, 30, 30]);
  assert.equal(due[0].title, 'Domain expires today');
  assert.equal(due[1].title, 'Domain expires tomorrow');
  assert.equal(due[3].title, 'Domain expires in 12 days', 'actual days left, not the milestone');
  assert.equal(due[4].title, 'Domain expires in 30 days');
  assert.equal(due[2].body, `seven.com renews on ${plus(7)}.`);
});

test('a milestone missed while the app was off still fires, once', () => {
  const leadDays = [30, 7, 1];
  const domains = [{ name: 'missed.com', renewalDate: plus(5) }];
  const due = dueReminders(domains, { today: TODAY, leadDays, alreadyNotified: [`missed.com|${plus(5)}|30`] });
  assert.equal(due.length, 1);
  assert.equal(due[0].milestone, 7);
  assert.equal(due[0].title, 'Domain expires in 5 days');

  const notified = due.map((d) => d.key);
  assert.deepEqual(dueReminders(domains, { today: TODAY, leadDays, alreadyNotified: notified }), [], 'same day');
  assert.deepEqual(dueReminders(domains, { today: shift(1), leadDays, alreadyNotified: notified }), [], 'next day');
});

test('passing several milestones at once raises only the most urgent', () => {
  const domains = [{ name: 'late.com', renewalDate: plus(1) }];
  const due = dueReminders(domains, { today: TODAY, leadDays: [30, 7, 1] });
  assert.equal(due.length, 1, 'no backlog');
  assert.equal(due[0].milestone, 1);
});

test('an earlier milestone never follows a more urgent one', () => {
  // Told about 7 days, never about 30: that 30-day reminder is not sent late.
  const domains = [{ name: 'skip.com', renewalDate: plus(5) }];
  const due = dueReminders(domains, { today: TODAY, alreadyNotified: [`skip.com|${plus(5)}|7`] });
  assert.deepEqual(due, []);
});

test('the same reminder is never raised twice', () => {
  const domains = [{ name: 'seven.com', renewalDate: plus(7) }];
  const first = dueReminders(domains, { today: TODAY });
  assert.equal(first.length, 1);
  const second = dueReminders(domains, { today: TODAY, alreadyNotified: first.map((d) => d.key) });
  assert.equal(second.length, 0, 'already notified');
});

test('a later milestone for the same domain still notifies', () => {
  const date = plus(1);
  const domains = [{ name: 'Seven.com', renewalDate: date }];
  const due = dueReminders(domains, {
    today: TODAY, alreadyNotified: [`seven.com|${date}|7`, `seven.com|${date}|30`],
  });
  assert.equal(due.length, 1);
  assert.equal(due[0].milestone, 1);
  assert.equal(due[0].key, `seven.com|${date}|1`, 'keys are case-insensitive on the name');
});

test('renewing a domain starts a fresh cycle', () => {
  // Reminded at 7 days for last year's date; the domain was renewed and is
  // now 7 days from its new date.
  const oldCycle = `renewed.com|${iso(shift(7 - 365))}|7`;
  const domains = [{ name: 'renewed.com', renewalDate: plus(7) }];
  const due = dueReminders(domains, { today: TODAY, alreadyNotified: [oldCycle] });
  assert.equal(due.length, 1);
  assert.equal(due[0].key, `renewed.com|${plus(7)}|7`);
});

test('expired domains are left alone', () => {
  const domains = [
    { name: 'yesterday.com', renewalDate: plus(-1) },
    { name: 'long-gone.com', renewalDate: plus(-400) },
  ];
  assert.deepEqual(dueReminders(domains, { today: TODAY, leadDays: [90, 30, 7, 1, 0] }), []);
});

test('day 0 is a milestone of its own', () => {
  const domains = [{ name: 'today.com', renewalDate: plus(0) }];
  const date = plus(0);
  const due = dueReminders(domains, { today: TODAY, alreadyNotified: [`today.com|${date}|1`] });
  assert.equal(due.length, 1);
  assert.equal(due[0].milestone, 0);
  assert.equal(due[0].title, 'Domain expires today');
});

test('custom lead days are honoured', () => {
  const domains = [
    { name: 'sixty.com', renewalDate: plus(60) },
    { name: 'twenty.com', renewalDate: plus(20) },
    { name: 'fourteen.com', renewalDate: plus(14) },
    { name: 'three.com', renewalDate: plus(3) },
    { name: 'sixty-one.com', renewalDate: plus(61) },
  ];
  const due = dueReminders(domains, { today: TODAY, leadDays: [60, 14] });
  assert.deepEqual(due.map((d) => [d.name, d.milestone]),
    [['three.com', 14], ['fourteen.com', 14], ['twenty.com', 60], ['sixty.com', 60]]);

  assert.deepEqual(dueReminders([{ name: 'week.com', renewalDate: plus(7) }],
    { today: TODAY, leadDays: [3] }), [], 'not yet at the only milestone');
});

test('a day-by-day run with gaps reminds once per milestone reached', () => {
  // The app runs only on some days; it is off in between.
  const domains = [{ name: 'run.com', renewalDate: plus(35) }];
  let notified = [];
  const fired = [];
  for (const day of [0, 6, 7, 25, 32, 33, 35, 36]) {        // 35, 29, 28, 10, 3, 2, 0, -1 days left
    const today = shift(day);
    const due = dueReminders(domains, { today, alreadyNotified: notified });
    for (const d of due) { fired.push(d.milestone); notified.push(d.key); }
    notified = pruneNotified(notified, domains, today);
  }
  assert.deepEqual(fired, [30, 7, 0]);
});

test('bad input never throws', () => {
  assert.deepEqual(dueReminders(null, { today: TODAY }), []);
  assert.deepEqual(dueReminders([null, 42, {}, { name: 'x' }, { name: '', renewalDate: plus(1) }], { today: TODAY }), []);
  assert.deepEqual(dueReminders([{ name: 'a.com', renewalDate: plus(1) }],
    { today: TODAY, leadDays: null, alreadyNotified: 'nope' }), []);
});

/* ------------------------------------------------------------- settings */

test('reminder settings fall back to the defaults', () => {
  const defaults = { enabled: true, leadDays: [30, 7, 1, 0] };
  for (const prefs of [undefined, null, 'x', 42, {}, { leadDays: 'abc' }, { leadDays: [] }]) {
    assert.deepEqual(normalizePrefs(prefs), defaults, JSON.stringify(prefs));
  }
  assert.deepEqual(normalizePrefs({ enabled: false }), { enabled: false, leadDays: [30, 7, 1, 0] });
  assert.equal(normalizePrefs({ enabled: 'no' }).enabled, true, 'only an explicit false switches off');
});

test('reminder lead days are limited to what the web app offers', () => {
  assert.deepEqual(normalizePrefs({ enabled: true, leadDays: [7, 5, '14', 365, -1, 7, null, 0, 2.5, true] }),
    { enabled: true, leadDays: [14, 7, 0] }, 'filtered, de-duplicated, most generous first');
  assert.deepEqual(normalizePrefs({ leadDays: [0, 1, 3, 7, 14, 30, 60, 90] }).leadDays,
    [90, 60, 30, 14, 7, 3, 1, 0]);
  assert.deepEqual(normalizePrefs({ leadDays: [5, 365, null] }).leadDays, [30, 7, 1, 0], 'nothing usable');
});

test('only names and renewal dates of real domains are kept', () => {
  assert.deepEqual(normalizeDomains([
    { name: 'a.com', renewalDate: '2027-01-01', password: 'secret', provider: 'x' },
    { name: 'b.com' },
    { name: '', renewalDate: '2027-01-01' },
    null, 42, 'c.com',
  ]), [{ name: 'a.com', renewalDate: '2027-01-01' }, { name: 'b.com', renewalDate: '' }]);
  assert.deepEqual(normalizeDomains(undefined), []);
});

/* -------------------------------------------------------------- pruning */

test('stored keys survive for the current cycle and go with it', () => {
  const domains = [
    { name: 'current.com', renewalDate: plus(5) },
    { name: 'renewed.com', renewalDate: plus(370) },
    { name: 'expired.com', renewalDate: plus(-1) },
  ];
  const kept = pruneNotified([
    `current.com|${plus(5)}|30`,
    `current.com|${plus(5)}|7`,
    `renewed.com|${plus(5)}|7`,          // old renewal date
    `expired.com|${plus(-1)}|0`,
    `gone.com|${plus(3)}|7`,             // no longer listed
    'current.com:7',                     // key from an older version
    42, null,
    `current.com|${plus(5)}|7`,          // duplicate
  ], domains, TODAY);
  assert.deepEqual(kept, [`current.com|${plus(5)}|30`, `current.com|${plus(5)}|7`]);

  // What survived still stops the milestone firing again tomorrow.
  assert.deepEqual(dueReminders(domains, { today: shift(1), alreadyNotified: kept }), []);
});

test('pruning bad input never throws', () => {
  assert.deepEqual(pruneNotified(null, null, TODAY), []);
  assert.deepEqual(pruneNotified({ a: 1 }, [null, {}, { name: 'x.com' }], TODAY), []);
});
