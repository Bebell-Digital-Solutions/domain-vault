'use strict';
/* ==========================================================================
   Pure helpers for the desktop client.

   Kept free of Electron imports so they can be unit-tested with plain node —
   there is no display in CI or on a headless machine, so anything that needs
   a BrowserWindow cannot be tested there.
   ========================================================================== */

/** Origins the app window is allowed to stay on. Anything else opens in the
    user's real browser, so a stray link cannot turn the app into a browser
    for arbitrary sites. */
const ALLOWED_ORIGINS = [
  'https://domain-vault.elnegocio.digital',
  'https://www.paypal.com',
  'https://www.sandbox.paypal.com',
];

function isAllowedUrl(url, allowed = ALLOWED_ORIGINS) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  // http is allowed only for local development.
  if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    return allowed.some((o) => o === parsed.origin);
  }
  if (parsed.protocol === 'http:') return true;
  return allowed.some((o) => o === parsed.origin);
}

/** Whole days from `today` until an ISO yyyy-mm-dd date. Negative when past. */
function daysUntil(isoDate, today = new Date()) {
  if (typeof isoDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const target = Date.UTC(
    Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, Number(isoDate.slice(8, 10)));
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target - start) / 86400000);
}

/**
 * Which domains deserve a notification right now.
 *
 * The server emails at 30/7/1 days. The desktop client mirrors that, and
 * `alreadyNotified` (persisted between runs) stops the same reminder firing
 * again every time the app starts.
 */
function dueReminders(domains, { today = new Date(), leadDays = [30, 7, 1], alreadyNotified = [] } = {}) {
  const seen = new Set(alreadyNotified);
  const out = [];

  for (const domain of Array.isArray(domains) ? domains : []) {
    if (!domain || typeof domain.name !== 'string') continue;
    const days = daysUntil(domain.renewalDate, today);
    if (days === null || !leadDays.includes(days)) continue;

    const key = notificationKey(domain.name, days);
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      key,
      name: domain.name,
      days,
      title: days === 1 ? 'Domain expires tomorrow' : `Domain expires in ${days} days`,
      body: `${domain.name} renews on ${domain.renewalDate}.`,
    });
  }

  // Soonest first.
  return out.sort((a, b) => a.days - b.days);
}

function notificationKey(name, days) {
  return `${String(name).toLowerCase()}:${days}`;
}

/** Drop stored keys for domains that are no longer within the reminder window. */
function pruneNotified(notified, domains, today = new Date()) {
  const live = new Set();
  for (const d of Array.isArray(domains) ? domains : []) {
    const days = daysUntil(d && d.renewalDate, today);
    if (days !== null && days >= 0) live.add(notificationKey(d.name, days));
  }
  return (Array.isArray(notified) ? notified : []).filter((k) => live.has(k));
}

module.exports = { ALLOWED_ORIGINS, isAllowedUrl, daysUntil, dueReminders, notificationKey, pruneNotified };
