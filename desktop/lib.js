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
  'https://app.getdomainvault.com',
  'https://domain-vault.elnegocio.digital',   // previous address, while it forwards
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

/** Lead days the web app lets a user pick, most generous first, and what
    applies when they have not picked any (same as the server). */
const LEAD_DAYS = [90, 60, 30, 14, 7, 3, 1, 0];
const DEFAULT_LEAD_DAYS = [30, 7, 1, 0];

/**
 * The user's reminder settings as the page sent them, made safe to use.
 * Anything missing or odd falls back to the defaults; only an explicit
 * `enabled: false` switches reminders off.
 */
function normalizePrefs(prefs) {
  const p = prefs && typeof prefs === 'object' ? prefs : {};
  const raw = Array.isArray(p.leadDays) ? p.leadDays : [];
  const leadDays = LEAD_DAYS.filter((d) => raw.some((v) => v === d || v === String(d)));
  return { enabled: p.enabled !== false, leadDays: leadDays.length ? leadDays : DEFAULT_LEAD_DAYS.slice() };
}

/** Only what a reminder needs: a name and a renewal date, both strings. */
function normalizeDomains(domains) {
  return (Array.isArray(domains) ? domains : [])
    .filter((d) => d && typeof d.name === 'string' && d.name !== '')
    .map((d) => ({ name: d.name, renewalDate: typeof d.renewalDate === 'string' ? d.renewalDate : '' }));
}

/**
 * Which domains deserve a notification right now. Mirrors the server's
 * `due_reminders` sweep:
 *
 * - The milestone is the most urgent lead day the domain has already reached
 *   (days left <= lead day), not an exact date match. A day the app was not
 *   running is caught up later, and passing several milestones at once gives
 *   one reminder, never a backlog.
 * - It is worked out without looking at what was already sent; otherwise a
 *   "7 days" reminder would be followed by a "30 days" one the next day.
 * - `alreadyNotified` (persisted between runs) is keyed on the renewal date,
 *   so renewing a domain starts a fresh cycle.
 * - Expired domains are left alone. Day 0 ("expires today") still counts.
 */
function dueReminders(domains, { today = new Date(), leadDays = DEFAULT_LEAD_DAYS, alreadyNotified = [] } = {}) {
  const leads = (Array.isArray(leadDays) ? leadDays : []).filter((n) => Number.isInteger(n) && n >= 0);
  const seen = new Set(Array.isArray(alreadyNotified) ? alreadyNotified : []);
  const out = [];

  for (const domain of Array.isArray(domains) ? domains : []) {
    if (!domain || typeof domain.name !== 'string' || !domain.name) continue;
    const days = daysUntil(domain.renewalDate, today);
    if (days === null || days < 0) continue;

    const reached = leads.filter((lead) => lead >= days);
    if (!reached.length) continue;
    const milestone = Math.min(...reached);

    const key = notificationKey(domain.name, domain.renewalDate, milestone);
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      key,
      name: domain.name,
      days,
      milestone,
      title: days === 0 ? 'Domain expires today'
        : days === 1 ? 'Domain expires tomorrow'
          : `Domain expires in ${days} days`,
      body: `${domain.name} renews on ${domain.renewalDate}.`,
    });
  }

  // Soonest first.
  return out.sort((a, b) => a.days - b.days);
}

/** One renewal cycle of one domain: everything in a key but the milestone. */
function cycleKey(name, renewalDate) {
  return `${String(name).toLowerCase()}|${renewalDate}|`;
}

function notificationKey(name, renewalDate, milestone) {
  return `${cycleKey(name, renewalDate)}${milestone}`;
}

/**
 * Keep stored keys only for renewal cycles that are still running: the domain
 * is still listed, with the same renewal date, and has not expired. Keys of
 * removed, renewed or expired domains are dropped, and so is anything else
 * (including keys written by older versions).
 */
function pruneNotified(notified, domains, today = new Date()) {
  const live = new Set();
  for (const d of Array.isArray(domains) ? domains : []) {
    if (!d || typeof d.name !== 'string') continue;
    const days = daysUntil(d.renewalDate, today);
    if (days !== null && days >= 0) live.add(cycleKey(d.name, d.renewalDate));
  }
  const kept = (Array.isArray(notified) ? notified : [])
    .filter((k) => typeof k === 'string' && live.has(k.slice(0, k.lastIndexOf('|') + 1)));
  return [...new Set(kept)];
}

module.exports = {
  ALLOWED_ORIGINS, isAllowedUrl, daysUntil,
  normalizePrefs, normalizeDomains, dueReminders, notificationKey, pruneNotified,
};
