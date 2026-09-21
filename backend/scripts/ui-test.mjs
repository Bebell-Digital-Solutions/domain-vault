#!/usr/bin/env node
/**
 * Real-browser tests for index.html and admin.html (headless Chrome).
 *
 * Needs the local stack, the functions served, and the site on port 5500:
 *   python3 -m http.server 5500 --bind 127.0.0.1      (from the repo root)
 *
 *   npm run test:ui
 *
 * CHROME_PATH overrides the browser binary; SHOTS=<dir> saves screenshots.
 */
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';

const SITE = process.env.SITE_URL_UNDER_TEST || 'http://127.0.0.1:5500';
const SHOTS = process.env.SHOTS;
const API = 'http://127.0.0.1:54321/functions/v1/api';
const PW = 'correct-horse-battery';
const t = Date.now();
const customer = `ui-customer-${t}@example.com`;
const admin = `ui-admin-${t}@example.com`;
const newcomer = `ui-newcomer-${t}@example.com`;
let failures = 0;
const sql = (q) => execSync('docker exec -i supabase_db_backend psql -U postgres -qtA', { input: q }).toString().trim();
const ok = (l, c, x = '') => { if (!c) failures++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? '  ' + x : ''}`); };
const register = (email) => fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'registerUser', email, password: PW }) }).then(r => r.json());

sql(`delete from rate_limits; update plan_prices set amount = null;
     delete from purchases where txn_id like 'UI-%';
     delete from admin_audit_log where admin_email like 'ui-admin-%';
     delete from auth.users where email like 'ui-%@example.com';`);
for (const e of [customer, admin, newcomer]) await register(e);
sql(`update profiles set status='active' where email in ('${customer}','${admin}');
     update profiles set is_admin=true where email='${admin}';`);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });

function watch(page, bucket) {
  page.on('pageerror', e => bucket.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') bucket.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  page.on('response', r => { if (r.status() >= 400) bucket.push(`http ${r.status()}: ${r.url()}`); });
}

async function login(page, email) {
  await page.goto(SITE + '/index.html');
  await page.fill('#authEmail', email);
  await page.fill('#authPassword', PW);
  await page.click('#authSubmitBtn');
  await page.waitForSelector('#auth-overlay', { state: 'hidden', timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('userPlanBadgeText').textContent.length > 0);
  // Dashboard data loads after the overlay closes and resets the active page.
  await page.waitForLoadState('networkidle');
}

// ---------------------------------------------------------------- customer
{
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage(); watch(page, errors);
  await login(page, customer);
  ok('customer logs in through the real page', true);
  ok('admin link hidden for customers', await page.locator('.sidebar .admin-link').isHidden());

  await page.click('#upgradePlanBtn');
  await page.waitForFunction(() => /not available yet/.test(document.getElementById('upgradePlanSelect').textContent));
  ok('unpriced packs shown as unavailable', await page.locator('#upgradePlanSelect option:not([disabled])').count() === 0);

  sql(`update plan_prices set amount = 49, currency='USD' where plan='Start-up';`);
  await page.click('#upgradeModal .modal-close').catch(() => {});
  await page.evaluate(() => document.getElementById('upgradeModal').style.display = 'none');
  await page.click('#upgradePlanBtn');
  await page.waitForFunction(() => /49\.00 USD/.test(document.getElementById('upgradePlanSelect').textContent));
  ok('priced pack shows its price', true, await page.locator('#upgradePlanSelect option:not([disabled])').first().textContent());
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/upgrade-modal.png` });

  // PayPal return: plan changes server-side, page picks it up without re-login.
  await page.evaluate(() => document.getElementById('upgradeModal').style.display = 'none');
  await page.goto(SITE + '/index.html?payment=success');
  await page.waitForSelector('#auth-overlay', { state: 'hidden', timeout: 20000 });
  sql(`update profiles set plan_override='Business' where email='${customer}';
       select recompute_plan(id) from profiles where email='${customer}';`);
  await page.waitForFunction(() => document.getElementById('userPlanBadgeText').textContent === 'BUSINESS', null, { timeout: 30000 });
  ok('plan badge updates after PayPal return', true);
  ok('?payment=success removed from the URL', !page.url().includes('payment='));

  ok('no JavaScript errors (desktop)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// --------------------------------------------------------- mobile navigation
{
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage(); watch(page, errors);
  await login(page, customer);
  await page.click('.menu-toggle');
  await page.waitForSelector('#mobileNav.open');
  const items = await page.locator('#mobileNav .menu-item[data-page]').count();
  ok('mobile drawer now contains the menu', items === 8, `${items} items`);
  await page.waitForTimeout(700);   // let the slide-in transition finish
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/mobile-nav.png` });
  await page.click('#mobileNav .menu-item[data-page="providers"]');
  ok('mobile menu navigates', await page.locator('#page-providers').evaluate(el => el.classList.contains('active')));
  ok('drawer closes after navigating', !(await page.locator('#mobileNav').evaluate(el => el.classList.contains('open'))));
  ok('no JavaScript errors (mobile)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ------------------------------------------------------------------- admin
{
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage(); watch(page, errors);
  await login(page, admin);
  await page.waitForSelector('.sidebar .admin-link:not([hidden])', { timeout: 15000 });
  ok('admin link visible for admins', true);

  await page.click('.sidebar .admin-link');
  await page.waitForURL(/admin\.html/);
  await page.waitForSelector('#appView:not([hidden])', { timeout: 15000 });
  ok('admin panel opens with the existing session', true);
  await page.waitForSelector('#overviewTiles .tile');
  ok('overview tiles render', await page.locator('#overviewTiles .tile').count() >= 7);
  await page.waitForSelector(`#pendingRows >> text=${newcomer}`);
  ok('pending newcomer listed', true);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/admin-overview.png`, fullPage: true });

  const row = page.locator('#pendingRows tr', { hasText: newcomer });
  await row.locator('button[data-act="activate"]').click();
  await page.waitForSelector(`#pendingRows >> text=${newcomer}`, { state: 'detached', timeout: 15000 });
  ok('activate button works', sql(`select status from profiles where email='${newcomer}'`) === 'active');

  await page.click('.tab[data-tab="users"]');
  await page.fill('#userSearch', newcomer);
  await page.waitForSelector(`#userRows >> text=${newcomer}`);
  await page.locator('#userRows tr', { hasText: newcomer }).locator('select[data-act="override"]').selectOption('Agency');
  await page.waitForFunction(() => /Plan updated/.test(document.getElementById('toast').textContent), null, { timeout: 15000 });
  ok('plan override from the users table', sql(`select plan from profiles where email='${newcomer}'`) === 'Agency');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/admin-users.png` });

  await page.click('.tab[data-tab="prices"]');
  await page.waitForSelector('#price-Business');
  await page.fill('#price-Business', '99');
  await page.click('button[data-plan="Business"]');
  await page.waitForFunction(() => /Business price saved/.test(document.getElementById('toast').textContent), null, { timeout: 15000 });
  ok('price saved from the prices tab', sql(`select amount from plan_prices where plan='Business'`) === '99.00');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/admin-prices.png` });

  sql(`insert into purchases (txn_id, email, payer_email, plan, amount, currency, status, reason)
       values ('UI-${t}', '${newcomer}', 'p@x.com', 'Agency', 0.01, 'USD', 'rejected', 'amount mismatch: paid 0.01 USD');`);
  await page.click('.tab[data-tab="sales"]');
  await page.waitForSelector(`#salesRows >> text=UI-${t}`);
  ok('sales tab shows payments needing review', await page.locator('#salesAttention').isVisible());
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/admin-sales.png` });

  await page.click('.tab[data-tab="audit"]');
  await page.waitForSelector('#auditRows >> text=set_price');
  ok('audit tab lists the changes', await page.locator('#auditRows tr').count() >= 3);

  // XSS: a hostile email must render as text.
  sql(`update profiles set location = '<img src=x onerror="window.__pwned=1">' where email='${newcomer}';`);
  await page.click('.tab[data-tab="users"]');
  await page.waitForSelector(`#userRows >> text=${newcomer}`);
  ok('database content is escaped (no XSS)', !(await page.evaluate(() => window.__pwned)));

  await page.click('#signOutBtn');
  await page.waitForSelector('#loginView:not([hidden])');
  ok('sign out returns to the login form', true);
  ok('no JavaScript errors (admin)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// --------------------------------------------------- admin page, non-admin
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage(); page.on('dialog', d => d.accept());
  await page.goto(SITE + '/admin.html');
  await page.waitForSelector('#loginView:not([hidden])');
  await page.fill('#loginEmail', customer);
  await page.fill('#loginPassword', PW);
  await page.click('#loginForm button[type=submit]');
  await page.waitForFunction(() => /admin rights/.test(document.getElementById('loginMsg').textContent), null, { timeout: 15000 });
  ok('customer is turned away from the admin panel', await page.locator('#appView').isHidden());
  await ctx.close();
}

// ---------------------------------------------------------------- downloads
{
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage(); watch(page, errors);
  await page.goto(SITE + '/downloads.html');
  await page.waitForSelector('.platform');

  ok('downloads: three platform cards', await page.locator('.platform').count() === 3);
  ok('downloads: headline', (await page.locator('h1').textContent()).trim() === 'Up and running in a minute.');
  ok('downloads: Linux card uses the Linux glyph', await page.locator('.platform:nth-child(3) .fa-linux').count() === 1);

  // Font Awesome draws the glyph in ::before; if the stylesheet or webfont
  // failed, the icon box collapses.
  const glyphs = await page.locator('.platform-icon i').evaluateAll(
    els => els.map(e => Math.round(e.getBoundingClientRect().width)));
  ok('downloads: brand glyphs actually render', glyphs.every(w => w >= 10), glyphs.join('/'));

  // config.js now points at a published release, so the buttons are live.
  // (Both states matter: the block below re-tests the unconfigured one.)
  ok('downloads: every button is a real release download',
    await page.locator('.btn-download[href*="releases/download"]').count() === 3);
  ok('downloads: designed copy is shown',
    /available for all major platforms/.test(await page.locator('#lede').textContent()));
  ok('downloads: second architecture offered for macOS and Linux',
    await page.locator('.alt-download[href]').count() === 2);

  const widths = await page.locator('.platform').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().width)));
  const buttonTops = await page.locator('.btn-download').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().top)));
  ok('downloads: cards equal width', new Set(widths).size === 1, widths.join('/'));
  ok('downloads: buttons align across cards', new Set(buttonTops).size === 1, buttonTops.join('/'));
  ok('downloads: no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  ok('downloads: no JavaScript errors', errors.length === 0, errors.join(' | '));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/downloads.png` });
  await ctx.close();
}

// The same page with NO builds configured must never show dead buttons.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();
  await page.route('**/config.js', route => route.fulfill({
    contentType: 'application/javascript', body: 'window.DOMAIN_VAULT_CONFIG = { downloads: {} };',
  }));
  await page.goto(SITE + '/downloads.html');
  await page.waitForSelector('.btn-download');
  ok('downloads: unconfigured builds show "Coming soon", not dead links',
    await page.locator('.btn-download.unavailable').count() === 3 &&
    await page.locator('.btn-download[href]').count() === 0);
  ok('downloads: copy stays honest while no build exists',
    /on the way/.test(await page.locator('#lede').textContent()));
  await ctx.close();
}

// Same page, but with builds configured in config.js.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();
  await page.route('**/config.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: "window.DOMAIN_VAULT_CONFIG = { downloads: { macos: 'https://example.com/a.dmg', windows: 'https://example.com/a.exe', linux: 'https://example.com/a.AppImage' } };",
  }));
  await page.goto(SITE + '/downloads.html');
  await page.waitForSelector('.btn-download');
  ok('downloads: configured builds become real download links',
    await page.locator('.btn-download[href][download]').count() === 3);
  ok('downloads: designed copy returns once builds exist',
    (await page.locator('[data-platform="macos"]').textContent()).trim() === 'Download for Mac' &&
    /available for all major platforms/.test(await page.locator('#lede').textContent()));
  await ctx.close();
}

// Mobile: the three cards must stack.
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const page = await ctx.newPage();
  await page.goto(SITE + '/downloads.html');
  await page.waitForSelector('.platform');
  const xs = await page.locator('.platform').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().x)));
  ok('downloads: cards stack on mobile', new Set(xs).size === 1, xs.join('/'));
  ok('downloads: no horizontal overflow on mobile',
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await ctx.close();
}

await browser.close();
sql(`delete from purchases where txn_id = 'UI-${t}';
     delete from admin_audit_log where admin_email = '${admin}';
     delete from auth.users where email in ('${customer}','${admin}','${newcomer}');
     update plan_prices set amount = null; delete from rate_limits;`);
console.log(failures ? `\n${failures} UI check(s) FAILED` : '\nAll UI checks passed.');
process.exit(failures ? 1 : 0);
