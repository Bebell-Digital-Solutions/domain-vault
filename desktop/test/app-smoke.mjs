/* Smoke test for a BUILT Linux app: connects to the running application over
   the Chrome DevTools protocol and checks the window, the preload bridge and
   IPC. Driven by ./verify-build.sh, which starts the app in a container with
   a virtual display. Not part of `npm test` (that one needs no display). */
import { chromium } from 'playwright-core';
let failures = 0;
const ok = (l, c, x = '') => { if (!c) failures++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? '  ' + x : ''}`); };

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] || await ctx.waitForEvent('page');
await page.waitForLoadState('domcontentloaded');

ok('desktop window loaded the app', /127\.0\.0\.1:5500/.test(page.url()), page.url());
ok('page title', (await page.title()).length > 0, await page.title());
ok('login screen rendered inside the desktop shell', await page.locator('#authEmail').isVisible());

// The preload bridge is what makes native reminders possible.
const bridge = await page.evaluate(() => ({
  present: typeof window.domainVaultDesktop === 'object',
  api: Object.keys(window.domainVaultDesktop || {}).sort(),
  nodeLeaked: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
}));
ok('preload bridge is exposed to the page', bridge.present, JSON.stringify(bridge.api));
ok('bridge exposes only reportRenewals + info', bridge.api.join(',') === 'info,reportRenewals', bridge.api.join(','));
ok('no node/process leaked into the renderer (context isolation holds)', bridge.nodeLeaked === false);

const info = await page.evaluate(() => window.domainVaultDesktop.info());
ok('shell reports its version over IPC', info && info.version === '1.0.0', JSON.stringify(info));

// Sending renewals must not throw, and must be accepted by the main process.
const sent = await page.evaluate(() => {
  try {
    window.domainVaultDesktop.reportRenewals([{ name: 'ipc-check.com', renewalDate: '2027-01-01' }]);
    return 'ok';
  } catch (e) { return String(e); }
});
ok('renderer can report renewals over IPC', sent === 'ok', sent);

if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/desktop-app.png' });
await browser.close();
console.log(failures ? `\n${failures} desktop check(s) FAILED` : '\nDesktop app verified.');
process.exit(failures ? 1 : 0);
