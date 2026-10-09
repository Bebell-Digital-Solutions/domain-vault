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
import { readFileSync } from 'node:fs';

const SITE = process.env.SITE_URL_UNDER_TEST || 'http://127.0.0.1:5500';
const SHOTS = process.env.SHOTS;
const API = 'http://127.0.0.1:54321/functions/v1/api';
const PW = 'correct-horse-battery';
const t = Date.now();
const customer = `ui-customer-${t}@example.com`;
const admin = `ui-admin-${t}@example.com`;
const newcomer = `ui-newcomer-${t}@example.com`;
const member = `ui-member-${t}@example.com`;
const teamOwner = `ui-teamowner-${t}@example.com`;
const teammate = `ui-teammate-${t}@example.com`;
const MAILPIT = 'http://127.0.0.1:54324';
let failures = 0;
const sql = (q) => execSync('docker exec -i supabase_db_backend psql -U postgres -qtA', { input: q }).toString().trim();
const ok = (l, c, x = '') => { if (!c) failures++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? '  ' + x : ''}`); };
const register = (email) => fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'registerUser', email, password: PW }) }).then(r => r.json());

sql(`delete from rate_limits; update plan_prices set amount = null;
     delete from purchases where txn_id like 'UI-%';
     delete from admin_audit_log where admin_email like 'ui-admin-%';
     delete from auth.users where email like 'ui-%@example.com';`);
for (const e of [customer, admin, newcomer, member, teamOwner]) await register(e);
sql(`update profiles set status='active' where email in ('${customer}','${admin}','${member}','${teamOwner}');
     update profiles set plan_override='Business' where email='${teamOwner}';
     select recompute_plan(id) from profiles where email='${teamOwner}';
     update profiles set is_admin=true where email='${admin}';`);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });

/** A browser context with the third-party chat widget stubbed out: the tests
    check our pages, and the widget's own scripts throw into the console. */
async function newContext(options) {
  const ctx = await browser.newContext(options);
  await ctx.route(/helpdesk\.icu|chatconnect\.cloud/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  return ctx;
}

function watch(page, bucket) {
  page.on('pageerror', e => bucket.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') bucket.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  page.on('response', r => { if (r.status() >= 400) bucket.push(`http ${r.status()}: ${r.url()}`); });
}

async function login(page, email, password = PW) {
  await page.goto(SITE + '/app/index.html');
  await page.fill('#authEmail', email);
  await page.fill('#authPassword', password);
  await page.click('#authSubmitBtn');
  await page.waitForSelector('#auth-overlay', { state: 'hidden', timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('userPlanBadgeText').textContent.length > 0);
  // Dashboard data loads after the overlay closes and resets the active page.
  await page.waitForLoadState('networkidle');
}

/** Reload with the stored session, as a returning user would. */
async function reload(page) {
  await page.reload();
  await page.waitForSelector('#auth-overlay', { state: 'hidden', timeout: 20000 });
  await page.waitForLoadState('networkidle');
}

// ---------------------------------------------------------------- customer
{
  const errors = [];
  const ctx = await newContext({ viewport: { width: 1400, height: 900 } });
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

  // The homepage's pricing table links to /app/?register&plan=…; a signed-in
  // visitor lands straight in that plan's checkout.
  await page.goto(SITE + '/app/index.html?plan=start-up');
  await page.waitForSelector('#upgradeModal', { state: 'visible', timeout: 20000 });
  await page.waitForFunction(() => /49\.00 USD/.test(document.getElementById('upgradePlanSelect').textContent));
  ok('a plan chosen on the homepage opens its checkout',
    await page.inputValue('#upgradePlanSelect') === 'Start-up' &&
    (await page.textContent('#proceedToCheckoutBtn')).includes('Subscribe'));
  await page.evaluate(() => document.getElementById('upgradeModal').style.display = 'none');

  // The lifetime-deal page links with &billing=lifetime; until lifetime deals
  // exist the visitor is told so and offered the yearly plans.
  await page.goto(SITE + '/app/index.html?plan=start-up&billing=lifetime');
  await page.waitForSelector('#upgradeModal', { state: 'visible', timeout: 20000 });
  await page.waitForFunction(() => /49\.00 USD/.test(document.getElementById('upgradePlanSelect').textContent));
  ok('lifetime link without lifetime deals explains and offers yearly',
    /aren't available yet/.test(await page.textContent('#upgradeDescText')) &&
    !page.url().includes('billing='));
  await page.evaluate(() => document.getElementById('upgradeModal').style.display = 'none');

  // PayPal return: plan changes server-side, page picks it up without re-login.
  await page.evaluate(() => document.getElementById('upgradeModal').style.display = 'none');
  await page.goto(SITE + '/app/index.html?payment=success');
  await page.waitForSelector('#auth-overlay', { state: 'hidden', timeout: 20000 });
  sql(`update profiles set plan_override='Business' where email='${customer}';
       select recompute_plan(id) from profiles where email='${customer}';`);
  await page.waitForFunction(() => document.getElementById('userPlanBadgeText').textContent === 'BUSINESS', null, { timeout: 30000 });
  ok('plan badge updates after PayPal return', true);
  ok('?payment=success removed from the URL', !page.url().includes('payment='));

  // Downloads open inside the dashboard, from config.js.
  await page.click('.sidebar .menu-item[data-page="downloads"]');
  await page.waitForSelector('#downloadCards .download-card');
  ok('downloads open inside the dashboard',
    await page.locator('#downloadCards .download-card').count() === 3 &&
    await page.locator('#downloadCards a[href*="releases/download"]').count() >= 3 &&
    page.url().includes('/app/'));

  // Tools come from the catalog the admin manages.
  await page.click('.sidebar .menu-item[data-page="tools"]');
  await page.waitForFunction(() => document.querySelectorAll('#toolsGridContainer .recommendation-card').length >= 15);
  const chips = await page.locator('#toolsFilterTags .filter-tag').allTextContents();
  ok('tools page shows the catalog with tag filters', chips.includes('All') && chips.includes('DNS') && chips.includes('Cheap renewal'), chips.join('/'));
  await page.click('#toolsFilterTags .filter-tag[data-tag="ssl"]');
  ok('a tag filter narrows the list', await page.locator('#toolsGridContainer .recommendation-card').count() === 1);

  ok('no JavaScript errors (desktop)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// --------------------------------------------------------- mobile navigation
{
  const errors = [];
  const ctx = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage(); watch(page, errors);
  await login(page, customer);
  await page.click('.menu-toggle');
  await page.waitForSelector('#mobileNav.open');
  const items = await page.locator('#mobileNav .menu-item[data-page]').count();
  ok('mobile drawer now contains the menu', items === 10, `${items} items`);
  await page.waitForTimeout(700);   // let the slide-in transition finish
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/mobile-nav.png` });
  await page.click('#mobileNav .menu-item[data-page="providers"]');
  ok('mobile menu navigates', await page.locator('#page-providers').evaluate(el => el.classList.contains('active')));
  ok('drawer closes after navigating', !(await page.locator('#mobileNav').evaluate(el => el.classList.contains('open'))));
  ok('no JavaScript errors (mobile)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ------------------------------------------------------------ team vaults
{
  const errors = [];
  const ownerCtx = await newContext({ viewport: { width: 1400, height: 900 } });
  const owner = await ownerCtx.newPage(); watch(owner, errors);
  const ownerId = sql(`select id from profiles where email='${teamOwner}'`);
  await login(owner, teamOwner);
  await owner.evaluate(async () => {
    await window.DomainVaultAPI.call('saveProvider', { provider: { name: 'Porkbun', url: 'https://porkbun.com', user: 'boss', pass: 'team-ui-secret' } });
    await window.DomainVaultAPI.call('saveDomain', { domain: { name: 'team-shared.com', provider: 'Porkbun', renewalDate: '2027-06-01', renewalPrice: 10 } });
  });

  // The owner invites someone from the Team page, view only.
  await owner.click('.sidebar .menu-item[data-page="team"]');
  await owner.waitForFunction(() => /1 of 5 people/.test(document.getElementById('teamSeats').textContent), null, { timeout: 15000 });
  ok('team page shows the seats of the plan', /Business plan includes 5 people/.test(await owner.textContent('#teamIntro')));
  await owner.fill('#inviteEmail', teammate);
  await owner.click('#inviteSubmitBtn');
  await owner.waitForSelector('#inviteLinkBox:not([hidden])', { timeout: 15000 });
  const link = await owner.inputValue('#inviteLink');
  ok('inviting gives a link to share', /\/app\/\?invite=[A-Za-z0-9_-]{43}$/.test(link), link);
  await owner.waitForFunction((m) => document.getElementById('teamInvitations').textContent.includes(m), teammate);
  ok('the invitation is listed as pending', true);
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/team-owner.png`, fullPage: true });

  // The invitee opens the link, signs up and logs in. (Five sign-ups from
  // this address already: the hourly limit would refuse a sixth.)
  sql('delete from rate_limits;');
  const mateCtx = await newContext({ viewport: { width: 1400, height: 900 } });
  const mate = await mateCtx.newPage(); watch(mate, errors);
  await mate.goto(link);
  await mate.waitForSelector('#registerFields', { state: 'visible' });
  ok('the invitation opens sign-up with an explanation',
    /invited to a team vault/i.test(await mate.textContent('#authMessage')) && !mate.url().includes('invite='));
  await mate.fill('#authEmail', teammate);
  await mate.fill('#authPassword', PW);
  await mate.click('#authSubmitBtn');
  await mate.waitForFunction(() => /joined the team|too many|error/i.test(document.getElementById('authMessage').textContent), null, { timeout: 20000 });
  const joined = await mate.textContent('#authMessage');
  ok('signing up joins the team, with approval still required for others', /joined the team/i.test(joined), joined);
  await mate.waitForTimeout(3500);
  await mate.fill('#authEmail', teammate);
  await mate.fill('#authPassword', PW);
  await mate.click('#authSubmitBtn');
  await mate.waitForSelector('#auth-overlay', { state: 'hidden', timeout: 20000 });
  await mate.waitForFunction(() => !document.getElementById('vaultBar').hidden &&
    document.getElementById('urgentRenewalsBody').textContent.includes('team-shared.com'), null, { timeout: 20000 });
  ok('a new member lands in the team vault', /view only/.test(await mate.textContent('#vaultRole')));
  ok('view only: no add buttons', await mate.locator('#addDomainBtn').isHidden());
  await mate.click('.sidebar .menu-item[data-page="domains"]');
  ok('view only: domains have no edit or delete buttons',
    await mate.locator('#domainsTableBody tr', { hasText: 'team-shared.com' }).count() === 1 &&
    await mate.locator('#domainsTableBody .action-btn[title="Edit"], #domainsTableBody .action-btn[title="Delete"]').count() === 0);
  await mate.click('.sidebar .menu-item[data-page="providers"]');
  await mate.click('.credentials-btn');
  ok('view only: stored passwords cannot be revealed', await mate.locator('#credRevealBtn').isHidden());
  await mate.click('#credentialsModal .modal-close');
  ok('view only: exports are hidden', await mate.locator('#exportCsvBtn').isHidden());

  await mate.selectOption('#vaultSelect', (await mate.locator('#vaultSelect option').first().getAttribute('value')));
  await mate.waitForFunction(() => document.getElementById('vaultRole').textContent.includes('You own'), null, { timeout: 15000 });
  ok('switching to their own vault shows their own (empty) data',
    await mate.locator('#domainsTableBody tr', { hasText: 'team-shared.com' }).count() === 0);

  // The owner lets them edit domains.
  await owner.click('.sidebar .menu-item[data-page="team"]');
  const row = owner.locator(`.team-row[data-email="${teammate}"]`);
  await row.waitFor({ timeout: 15000 });
  await row.locator('input[data-perm="editDomains"]').check();
  await row.locator('[data-team-act="save-member"]').click();
  await owner.waitForFunction(() => /Permissions saved/.test(document.getElementById('toast').textContent), null, { timeout: 15000 });
  ok('the owner changes permissions with checkboxes', true);

  await mate.selectOption('#vaultSelect', ownerId);
  await mate.waitForFunction(() => /edit domains/.test(document.getElementById('vaultRole').textContent), null, { timeout: 15000 });
  await mate.click('.sidebar .menu-item[data-page="domains"]');
  await mate.click('#addDomainBtnSecondary');
  await mate.fill('#domainName', 'added-by-teammate.com');
  await mate.selectOption('#domainProvider', 'Porkbun');
  await mate.fill('#purchaseDate', '2025-01-01');
  await mate.fill('#renewalDate', '2027-02-01');
  await mate.fill('#purchasePrice', '1');
  await mate.fill('#renewalPrice', '1');
  await mate.click('#formSubmitBtn');
  await mate.waitForFunction(() => /Domain saved/.test(document.getElementById('toast').textContent), null, { timeout: 15000 });
  ok("a member's new domain is saved into the owner's vault",
    sql(`select count(*) from domains where name='added-by-teammate.com' and user_id='${ownerId}'`) === '1');
  ok('…and they still cannot delete', await mate.locator('#domainsTableBody .action-btn[title="Delete"]').count() === 0);

  await owner.click('.sidebar .menu-item[data-page="dashboard"]');
  await owner.click('.sidebar .menu-item[data-page="team"]');
  await owner.waitForFunction(() => /added the domain added-by-teammate\.com/.test(document.getElementById('teamActivity').textContent), null, { timeout: 15000 });
  ok('the owner sees it in the activity log', true);

  // The vault bar and the Team page fit a phone.
  await mate.setViewportSize({ width: 390, height: 844 });
  await mate.click('.menu-toggle');
  await mate.click('#mobileNav .menu-item[data-page="team"]');
  await mate.waitForFunction(() => document.getElementById('teamMemberships').hidden === false);
  await mate.waitForTimeout(700);   // let the drawer slide away
  ok('team page and vault bar fit a phone', await mate.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  if (SHOTS) await mate.screenshot({ path: `${SHOTS}/team-member-mobile.png`, fullPage: true });

  ok('team journey: no JavaScript errors', errors.length === 0, errors.join(' | '));
  await ownerCtx.close();
  await mateCtx.close();
}

// ------------------------------------------------- account features (member)
{
  // Refusals answered with 4xx are part of this journey; anything else is not.
  const errors = [];
  const ctx = await newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage(); watch(page, errors);
  // The duplicate-domain refusal below, as the network and the console report it.
  const expected = (e) => /http 409: .*functions\/v1\/api$/.test(e) || /status of 409 \(Conflict\)/.test(e);

  const hostile = `<img src=x onerror="window.__pwned=1">.com`;
  const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  await login(page, member);
  await page.evaluate(async ([name, date]) => {
    await window.DomainVaultAPI.call('saveDomains', { domains: [{ name, renewalDate: date }] });
    await window.DomainVaultAPI.call('saveProviders', { providers: [
      { name: 'Porkbun', url: 'https://porkbun.com', user: 'me', pass: 'porkbun-secret-1' }] });
  }, [hostile, soon]);
  await reload(page);
  await page.click('.sidebar .menu-item[data-page="notifications"]');
  await page.waitForSelector('#notificationsList .notification-item');
  ok('notifications render a hostile domain name as text (no XSS)',
    !(await page.evaluate(() => window.__pwned)) &&
    (await page.locator('#notificationsList').textContent()).includes('<img'));

  // Renewal pop-ups go away on their own; a user in a hurry closes them.
  for (const b of await page.locator('.notification-dismiss-btn').all()) await b.click().catch(() => {});
  await page.waitForFunction(() => document.getElementById('persistent-notifications-container').children.length === 0);
  ok('renewal pop-ups can be dismissed', true);

  // A save the server refuses must say so and leave the screen matching the server.
  await page.click('.sidebar .menu-item[data-page="domains"]');
  for (const _ of [1, 2]) {
    await page.click('#addDomainBtnSecondary');
    await page.fill('#domainName', 'twice.com');
    await page.selectOption('#domainProvider', 'Porkbun');
    await page.fill('#purchaseDate', '2025-01-01');
    await page.fill('#renewalDate', '2027-01-01');
    await page.fill('#purchasePrice', '1');
    await page.fill('#renewalPrice', '1');
    await page.click('#formSubmitBtn');
    await page.waitForTimeout(1500);
  }
  await page.waitForFunction(() => /already have a domain/i.test(document.getElementById('toast').textContent), null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  ok('a refused save shows the server\'s reason', true);
  ok('…and the table goes back to what is stored',
    await page.locator('#domainsTableBody tr', { hasText: 'twice.com' }).count() === 1);

  // Stored registrar password: reveal on request.
  await page.click('.sidebar .menu-item[data-page="providers"]');
  await page.click('.credentials-btn');
  ok('stored password starts masked', (await page.locator('#credPass').textContent()).includes('•'));
  await page.click('#credRevealBtn');
  await page.waitForFunction(() => document.getElementById('credPass').textContent === 'porkbun-secret-1', null, { timeout: 15000 });
  ok('reveal shows the stored password', true);
  await page.click('#credentialsModal .modal-close');
  ok('closing the modal forgets it', (await page.locator('#credPass').textContent()) === '');

  // Calendar subscription.
  await page.click('.sidebar .menu-item[data-page="calendar"]');
  await page.click('#syncGCalBtn');
  await page.waitForFunction(() => /\/calendar\?token=/.test(document.getElementById('calendarFeedUrl').value), null, { timeout: 15000 });
  const feedUrl = await page.inputValue('#calendarFeedUrl');
  const feed = await fetch(feedUrl);
  ok('"Sync to Google" gives a working calendar link', feed.status === 200 && (await feed.text()).includes('BEGIN:VEVENT'));
  ok('Google Calendar button pre-fills the subscription',
    (await page.getAttribute('#googleFeedLink', 'href')).startsWith('https://calendar.google.com/calendar/r?cid=webcal'));
  await page.click('#calendarFeedModal .modal-close');

  // Exports.
  await page.click('.sidebar .menu-item[data-page="settings"]');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportJsonBtn')]);
  const exported = JSON.parse(readFileSync(await download.path(), 'utf8'));
  ok('JSON export has the vault and no passwords',
    exported.domains.length === 2 && exported.providers[0].hasStoredPassword === true &&
    !JSON.stringify(exported).includes('porkbun-secret-1'));

  // Custom accent colour survives a reload.
  await page.evaluate(() => {
    const picker = document.getElementById('customColorPicker');
    picker.value = '#12abef';
    picker.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => /Accent color saved/.test(document.getElementById('toast').textContent), null, { timeout: 15000 });
  await reload(page);
  ok('custom accent colour is saved', (await page.evaluate(() =>
    document.documentElement.style.getPropertyValue('--primary').trim())) === '#12abef');

  // Change password from Settings.
  const NEW_PW = 'another-horse-battery';
  await page.click('.sidebar .menu-item[data-page="settings"]');
  await page.fill('#currentPassword', PW);
  await page.fill('#newPassword', NEW_PW);
  await page.fill('#confirmNewPassword', NEW_PW);
  await page.click('#settingsPasswordForm button[type=submit]');
  await page.waitForFunction(() => /Password changed/.test(document.getElementById('toast').textContent), null, { timeout: 15000 });
  await page.click('#logoutBtn');
  await login(page, member, NEW_PW);
  ok('password changed from Settings', true);

  // Forgotten password, start to finish: request, email, link, new password.
  await page.click('#logoutBtn');
  await page.click('#forgotPasswordLink');
  ok('forgot-password form hides the password field', await page.locator('#authPassword').isHidden());
  await page.fill('#authEmail', member);
  await page.click('#authSubmitBtn');
  await page.waitForFunction(() => /reset link is on its way/i.test(document.getElementById('authMessage').textContent), null, { timeout: 15000 });
  let link = null;
  for (let i = 0; i < 20 && !link; i++) {
    const found = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent('to:' + member)}`).then(r => r.json());
    const id = found.messages?.[0]?.ID;
    if (id) {
      const msg = await fetch(`${MAILPIT}/api/v1/message/${id}`).then(r => r.json());
      link = (msg.Text || '').match(/https?:\/\/\S+\/auth\/v1\/verify\?\S+/)?.[0] ?? null;
    }
    if (!link) await new Promise(r => setTimeout(r, 500));
  }
  ok('reset email arrives with a link', !!link);
  const verified = await fetch(link, { redirect: 'manual' });
  const fragment = (verified.headers.get('location') || '').split('#')[1] || '';
  ok('the link verifies as a recovery', /type=recovery/.test(fragment));
  // The link arrives as a fresh page load (from the mail client, through Auth's
  // redirect); a same-page hash change would not be one.
  await page.goto('about:blank');
  await page.goto(`${SITE}/app/index.html#${fragment}`);
  await page.waitForSelector('#authConfirmGroup', { state: 'visible' });
  ok('the app opens the "set a new password" form', !page.url().includes('access_token'),
    'token removed from the address bar');
  const RESET_PW = 'reset-horse-battery';
  await page.fill('#authPassword', RESET_PW);
  await page.fill('#authPasswordConfirm', RESET_PW);
  await page.click('#authSubmitBtn');
  await page.waitForFunction(() => /Password updated/.test(document.getElementById('authMessage').textContent), null, { timeout: 15000 });
  await login(page, member, RESET_PW);
  ok('logs in with the reset password', true);

  const unexpected = errors.filter(e => !expected(e));
  ok('no unexpected JavaScript or HTTP errors (account features)', unexpected.length === 0, unexpected.join(' | '));
  await ctx.close();
}

// ------------------------------------------------------------------- admin
{
  const errors = [];
  const ctx = await newContext({ viewport: { width: 1400, height: 900 } });
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

  // Tools tab: add a tool, see it listed, delete it.
  await page.click('.tab[data-tab="tools"]');
  await page.waitForSelector('#catalogRows tr');
  await page.fill('#catalogName', `UI Tool ${t}`);
  await page.fill('#catalogUrl', 'https://example.com/ui-tool');
  await page.fill('#catalogTags', 'dns');
  await page.click('#catalogSave');
  await page.waitForSelector(`#catalogRows >> text=UI Tool ${t}`, { timeout: 15000 });
  ok('admin adds a tool from the Tools tab', sql(`select count(*) from catalog_items where name = 'UI Tool ${t}'`) === '1');
  await page.locator('#catalogRows tr', { hasText: `UI Tool ${t}` }).locator('button[data-act="delete-tool"]').click();
  await page.waitForSelector(`#catalogRows >> text=UI Tool ${t}`, { state: 'detached', timeout: 15000 });
  ok('…and deletes it', sql(`select count(*) from catalog_items where name = 'UI Tool ${t}'`) === '0');

  await page.click('.tab[data-tab="prices"]');
  await page.waitForSelector('#unpaidPlan');
  await page.selectOption('#unpaidPlan', 'Free');
  await page.click('#saveBillingConfig');
  await page.waitForFunction(() => /Plan settings saved/.test(document.getElementById('toast').textContent), null, { timeout: 15000 });
  ok('plan settings saved from the admin panel', sql(`select unpaid_plan from billing_config`) === 'Free');
  await page.selectOption('#unpaidPlan', 'Personal');
  await page.click('#saveBillingConfig');
  let restored = '';
  for (let i = 0; i < 20 && restored !== 'Personal'; i++) {
    await page.waitForTimeout(500);
    restored = sql(`select unpaid_plan from billing_config`);
  }
  ok('…and set back', restored === 'Personal', restored);
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
  const ctx = await newContext();
  const page = await ctx.newPage(); page.on('dialog', d => d.accept());
  await page.goto(SITE + '/app/admin.html');
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
  const ctx = await newContext({ viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage(); watch(page, errors);
  await page.goto(SITE + '/downloads.html');
  await page.waitForSelector('.platform');

  ok('downloads: three platform cards', await page.locator('.platform').count() === 3);
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
  const ctx = await newContext({ viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();
  await page.route('**/config.js', route => route.fulfill({
    contentType: 'application/javascript', body: 'window.DOMAIN_VAULT_CONFIG = { downloads: {} };',
  }));
  await page.goto(SITE + '/downloads.html');
  await page.waitForSelector('.btn-download');
  ok('downloads: unconfigured builds show "Coming soon", not dead links',
    await page.locator('.btn-download.unavailable').count() === 3 &&
    await page.locator('.btn-download[href]').count() === 0);
  await ctx.close();
}

// Same page, but with builds configured in config.js.
{
  const ctx = await newContext({ viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();
  await page.route('**/config.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: "window.DOMAIN_VAULT_CONFIG = { downloads: { macos: 'https://example.com/a.dmg', windows: 'https://example.com/a.exe', linux: 'https://example.com/a.AppImage' } };",
  }));
  await page.goto(SITE + '/downloads.html');
  await page.waitForSelector('.btn-download');
  ok('downloads: configured builds become real download links',
    await page.locator('.btn-download[href][download]').count() === 3);
  ok('downloads: button labels return once builds exist',
    (await page.locator('[data-platform="macos"]').textContent()).trim() === 'Download for Mac');
  await ctx.close();
}

// Mobile: the three cards must stack.
{
  const ctx = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
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
     delete from auth.users where email in ('${customer}','${admin}','${newcomer}','${member}','${teamOwner}','${teammate}');
     update plan_prices set amount = null, lifetime_amount = null;
     update billing_config set unpaid_plan = 'Personal', require_approval = true;
     delete from rate_limits;`);
console.log(failures ? `\n${failures} UI check(s) FAILED` : '\nAll UI checks passed.');
process.exit(failures ? 1 : 0);
