#!/usr/bin/env node
/**
 * End-to-end smoke test for the frontend client and the admin API.
 *
 * Loads ../api.js — the actual file the browser loads — into stubbed
 * browser contexts (fake window + localStorage, real fetch) and drives full
 * user and admin journeys against a running local stack.
 *
 * Requires `supabase start` and `supabase functions serve --env-file ...`.
 *
 *   node scripts/smoke-test.mjs        (or: npm run smoke)
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const API_JS = readFileSync(fileURLToPath(new URL("../../api.js", import.meta.url)), "utf8");
const CONFIG = {
  supabaseUrl: "http://127.0.0.1:54321",
  functionsUrl: "http://127.0.0.1:54321/functions/v1",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
};
const PW = "correct-horse-battery";
const stamp = Date.now();
let failures = 0;

const sql = (q) =>
  execSync("docker exec -i supabase_db_backend psql -U postgres -qtA", { input: q }).toString().trim();

function ok(label, cond, extra = "") {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
}

/** A fresh, isolated "browser tab" running api.js. */
function browser() {
  const store = new Map();
  const win = {
    DOMAIN_VAULT_CONFIG: CONFIG,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
    fetch,
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(API_JS, win);
  return { api: win.DomainVaultAPI, store };
}

sql("delete from rate_limits;");

// ============================================================ customer
console.log("--- customer journey ---");
const { api: API, store } = browser();
const email = `client-${stamp}@example.com`;

let r = await API.call("registerUser", { email, password: PW });
ok("register", r.success === true, r.message);

r = await API.call("loginUser", { email, password: PW });
ok("login refused while pending", r.success === false && /pending/i.test(r.message), r.message);

sql(`update profiles set status = 'active' where email = '${email}';`);

r = await API.call("loginUser", { email, password: PW });
ok("login after activation", r.success === true);
ok("session persisted to storage", store.has("dv.session"));
ok("regular user is not flagged admin", r.user && r.user.isAdmin === false);

r = await API.call("saveDomains", { domains: [
  { name: "client-a.com", provider: "Namecheap", renewalDate: "2027-01-01", renewalPrice: "9.99", autoRenew: true },
] });
ok("saveDomains", r.success === true);

r = await API.call("getUserData", {});
ok("getUserData returns the domain", r.domains?.length === 1, JSON.stringify(r.domains?.[0]?.name));
ok("getUserData carries plan + purchases", r.plan === "Personal" && Array.isArray(r.purchases));

r = await API.call("saveProviders", { providers: [
  { name: "Namecheap", url: "https://namecheap.com", user: "me", pass: "registrar-pw-123" },
] });
ok("saveProviders with password", r.success === true);
ok("password not echoed back", r.providers?.[0]?.pass === "" && r.providers?.[0]?.hasPassword === true);

r = await API.revealPassword(r.providers[0].id);
ok("revealPassword round-trip", r.success === true && r.password === "registrar-pw-123");

r = await API.call("adminOverview", {});
ok("customer is refused admin actions", r.success === false && /administrators only/i.test(r.message), r.message);

// Plan changes server-side; the client must pick it up without re-login.
sql(`update profiles set plan_override = 'Business' where email = '${email}';
     select recompute_plan(id) from profiles where email = '${email}';`);
r = await API.call("getUserData", {});
ok("plan change is visible without logging in again", r.plan === "Business", r.plan);
API.updateUser({ plan: r.plan });
ok("updateUser refreshes the stored session", JSON.parse(store.get("dv.session")).user.plan === "Business");

const restored = await API.restore();
ok("session survives reload", restored?.email === email);

API.signOut();
ok("signOut clears storage", !store.has("dv.session"));

// ================================================================ admin
console.log("--- admin journey ---");
const { api: ADMIN } = browser();
const adminEmail = `admin-${stamp}@example.com`;
const newcomer = `newcomer-${stamp}@example.com`;

await ADMIN.call("registerUser", { email: adminEmail, password: PW });
sql(`update profiles set status = 'active', is_admin = true where email = '${adminEmail}';`);
r = await ADMIN.call("loginUser", { email: adminEmail, password: PW });
ok("admin login flags isAdmin", r.success && r.user.isAdmin === true);
const adminId = r.user.id;

r = await ADMIN.call("adminOverview", {});
ok("adminOverview", r.success === true && typeof r.users?.total === "number", `users=${r.users?.total}`);

await browser().api.call("registerUser", { email: newcomer, password: PW });
r = await ADMIN.call("adminListUsers", { status: "pending", search: "newcomer-" + stamp });
const target = r.users?.[0];
ok("pending newcomer appears in the list", r.success && target?.email === newcomer);

r = await ADMIN.call("adminUpdateUser", { userId: target.id, status: "active" });
ok("admin activates the newcomer", r.success && r.user.status === "active");

r = await ADMIN.call("adminUpdateUser", { userId: target.id, planOverride: "Agency" });
ok("admin plan override applies", r.success && r.user.plan === "Agency" && r.user.plan_override === "Agency");

r = await ADMIN.call("adminUpdateUser", { userId: target.id, planOverride: "" });
ok("clearing the override falls back to purchases", r.success && r.user.plan === "Personal" && r.user.plan_override === null);

r = await ADMIN.call("adminUpdateUser", { userId: target.id, status: "hacked" });
ok("invalid status rejected", r.success === false);

r = await ADMIN.call("adminUpdateUser", { userId: adminId, isAdmin: false });
ok("admin cannot remove their own rights", r.success === false && /own admin/i.test(r.message), r.message);

r = await ADMIN.call("adminUpdateUser", { userId: adminId, status: "suspended" });
ok("admin cannot suspend themselves", r.success === false);

r = await ADMIN.call("adminSetPrice", { plan: "Start-up", amount: "29", currency: "usd" });
ok("admin sets a price", r.success && r.prices.find((p) => p.plan === "Start-up")?.amount === 29);

r = await browser().api.call("getPrices", {});
ok("price is public", r.success && r.prices.find((p) => p.plan === "Start-up")?.amount === 29);

r = await ADMIN.call("adminSetPrice", { plan: "Agency", amount: "-5" });
ok("negative price rejected", r.success === false);

r = await ADMIN.call("adminSetPrice", { plan: "Start-up", amount: null, currency: "USD" });
ok("admin takes a pack off sale", r.success && r.prices.find((p) => p.plan === "Start-up")?.amount === null);

r = await ADMIN.call("adminSales", {});
ok("adminSales", r.success === true && Array.isArray(r.purchases));

r = await ADMIN.call("adminAudit", { limit: 50 });
const actions = (r.entries || []).filter((e) => e.admin_email === adminEmail).map((e) => e.action);
ok("every admin change is audited", actions.filter((a) => a === "update_user").length === 3 &&
  actions.filter((a) => a === "set_price").length === 2, actions.join(","));

// ============================================================== cleanup
sql(`delete from admin_audit_log where admin_email = '${adminEmail}';
     delete from auth.users where email in ('${email}', '${adminEmail}', '${newcomer}');
     update plan_prices set amount = null;
     delete from rate_limits;`);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll client and admin flows passed.");
process.exit(failures ? 1 : 0);
