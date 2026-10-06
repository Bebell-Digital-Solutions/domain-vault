#!/usr/bin/env node
/**
 * End-to-end tests for the PayPal webhook, against the local stack.
 *
 * PayPal itself is replaced by a stub container that answers VERIFIED (or
 * INVALID when the body contains forged=1). Everything else is real: the
 * function, the database, the ledger and recompute_plan.
 *
 * Setup (see README "Testing"):
 *   docker run -d --name dv-paypal-mock --network supabase_network_backend node:22-alpine node -e "..."
 *   supabase functions serve --env-file supabase/tests/functions.env
 *
 *   node scripts/webhook-test.mjs      (or: npm run test:webhook)
 */
import { execSync } from "node:child_process";

const BASE = "http://127.0.0.1:54321/functions/v1";
const RECEIVER = "seller@example.com";
const EMAIL = `buyer-${Date.now()}@example.com`;
const run = Date.now().toString(36);
let failures = 0;

const sql = (q) =>
  execSync(`docker exec -i supabase_db_backend psql -U postgres -qtA`, { input: q }).toString().trim();

function check(label, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

async function ipn(fields) {
  const body = new URLSearchParams({
    receiver_email: RECEIVER,
    custom: EMAIL,
    payer_email: "payer@paypal.example",
    mc_currency: "USD",
    ...fields,
  }).toString();
  const res = await fetch(`${BASE}/billing-webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return { status: res.status, text: await res.text() };
}

const account = () => sql(`select plan || '/' || status from profiles where email = '${EMAIL}';`);
const purchase = (txn) => sql(`select coalesce(status,'') from purchases where txn_id = '${txn}';`);
const txn = (name) => `${run}-${name}`;

// ---------------------------------------------------------------- setup
sql(`delete from rate_limits;`);
// One-time payments are checked against the lifetime price, subscriptions
// against the yearly price.
sql(`update plan_prices set
       lifetime_amount = case plan when 'Start-up' then 29 when 'Business' then 99 when 'Agency' then 299 end,
       amount = case plan when 'Personal' then 29 when 'Start-up' then 48 when 'Business' then 79 when 'Agency' then 98 end,
       currency = 'USD';`);

const reg = await fetch(`${BASE}/api`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "registerUser", email: EMAIL, password: "correct-horse-battery" }),
}).then((r) => r.json());
check("buyer registered (pending)", reg.success && account() === "Personal/pending", account());

// ------------------------------------------------------------- refusals
let r = await ipn({ txn_id: txn("forged"), payment_status: "Completed", item_number: "agency", mc_gross: "299.00", forged: "1" });
check("unverified notification is ignored", account() === "Personal/pending" && purchase(txn("forged")) === "", r.text);

r = await ipn({ txn_id: txn("recv"), payment_status: "Completed", item_number: "agency", mc_gross: "299.00", receiver_email: "attacker@example.com" });
check("payment to another receiver is ignored", account() === "Personal/pending" && purchase(txn("recv")) === "", r.text);

r = await ipn({ txn_id: txn("cheap"), payment_status: "Completed", item_number: "agency", item_name: "Agency", mc_gross: "0.01" });
check("Agency for 0.01 is rejected", account() === "Personal/pending" && purchase(txn("cheap")) === "rejected", r.text);

r = await ipn({ txn_id: txn("eur"), payment_status: "Completed", item_number: "business", mc_gross: "99.00", mc_currency: "EUR" });
check("right amount, wrong currency is rejected", purchase(txn("eur")) === "rejected" && account() === "Personal/pending", r.text);

r = await ipn({ txn_id: txn("unknown"), payment_status: "Completed", item_name: "Mystery box", mc_gross: "29.00" });
check("unknown pack is rejected", purchase(txn("unknown")) === "rejected", r.text);

// ------------------------------------------- pending, then completed
r = await ipn({ txn_id: txn("A"), payment_status: "Pending", pending_reason: "echeck", item_number: "startup", mc_gross: "29.00" });
check("pending payment grants nothing", purchase(txn("A")) === "pending" && account() === "Personal/pending", r.text);

r = await ipn({ txn_id: txn("A"), payment_status: "Completed", item_number: "startup", mc_gross: "29.00" });
check("same transaction clearing to Completed is applied, account activated",
  purchase(txn("A")) === "completed" && account() === "Start-up/active", `${r.text}; ${account()}`);

r = await ipn({ txn_id: txn("A"), payment_status: "Completed", item_number: "startup", mc_gross: "29.00" });
const rows = sql(`select count(*) from purchases where txn_id = '${txn("A")}';`);
check("replayed notification changes nothing", rows === "1" && account() === "Start-up/active", r.text);

// ------------------------------------------------------ upgrade + refunds
r = await ipn({ txn_id: txn("B"), payment_status: "Completed", item_number: "business", mc_gross: "99.00" });
check("Business purchase upgrades", account() === "Business/active", r.text);

r = await ipn({ txn_id: txn("B-part"), parent_txn_id: txn("B"), payment_status: "Refunded", mc_gross: "-10.00" });
check("partial refund keeps the pack", account() === "Business/active" && purchase(txn("B")) === "completed", r.text);

r = await ipn({ txn_id: txn("B-full"), parent_txn_id: txn("B"), payment_status: "Refunded", mc_gross: "-99.00" });
check("full refund withdraws Business, falls back to Start-up",
  account() === "Start-up/active" && purchase(txn("B")) === "refunded", `${r.text}; ${account()}`);

r = await ipn({ txn_id: txn("A-cb"), parent_txn_id: txn("A"), payment_status: "Reversed", mc_gross: "-29.00", reason_code: "chargeback" });
check("chargeback withdraws Start-up", account() === "Personal/active" && purchase(txn("A")) === "reversed", r.text);

r = await ipn({ txn_id: txn("A-cbx"), parent_txn_id: txn("A"), payment_status: "Canceled_Reversal", mc_gross: "29.00" });
check("cancelled chargeback restores Start-up", account() === "Start-up/active" && purchase(txn("A")) === "completed", r.text);

// ----------------------------------------------------------- edge cases
r = await ipn({ txn_id: txn("tax"), payment_status: "Completed", item_number: "agency", mc_gross: "329.00", tax: "30.00" });
check("price + tax is accepted (tax excluded from the check)", account() === "Agency/active", r.text);

r = await ipn({ txn_id: txn("nobody"), payment_status: "Completed", item_number: "startup", mc_gross: "29.00", custom: "ghost@example.com" });
check("payment for an unknown account is held as unmatched", purchase(txn("nobody")) === "unmatched", r.text);

r = await ipn({ txn_id: txn("deny"), payment_status: "Pending", item_number: "business", mc_gross: "99.00" });
r = await ipn({ txn_id: txn("deny"), payment_status: "Denied", item_number: "business", mc_gross: "99.00" });
check("denied pending payment is marked failed", purchase(txn("deny")) === "failed" && account() === "Agency/active", r.text);

r = await ipn({ txn_id: txn("ltd-yearly-price"), payment_status: "Completed", item_number: "agency", mc_gross: "98.00" });
check("a one-time payment of the yearly price buys nothing", purchase(txn("ltd-yearly-price")) === "rejected", r.text);

// ====================================================== yearly subscriptions
const SUB_EMAIL = `subscriber-${Date.now()}@example.com`;
const S = (name) => `S-${run}-${name}`;
const subAccount = () => sql(`select plan || '/' || status from profiles where email = '${SUB_EMAIL}';`);
const subStatus = (id) => sql(`select coalesce(status,'') from subscriptions where subscr_id = '${id}';`);
const paidUntilDays = (t) => Number(sql(`select round(extract(epoch from paid_until - now()) / 86400) from purchases where txn_id = '${t}';`));
const sub = (fields) => ipn({ custom: SUB_EMAIL, payer_email: "subscriber@paypal.example", ...fields });

await fetch(`${BASE}/api`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "registerUser", email: SUB_EMAIL, password: "correct-horse-battery" }),
});
check("subscriber registered (pending)", subAccount() === "Personal/pending", subAccount());

r = await sub({ txn_type: "subscr_signup", subscr_id: S("bad-period"), item_number: "business", mc_amount3: "79.00", period3: "1 M" });
check("a monthly subscription to a yearly plan is rejected", subStatus(S("bad-period")) === "rejected", r.text);

r = await sub({ txn_type: "subscr_signup", subscr_id: S("biz"), item_number: "business", item_name: "Domain Vault Business", mc_amount3: "79.00", period3: "1 Y" });
check("signup is recorded but grants nothing yet", subStatus(S("biz")) === "active" && subAccount() === "Personal/pending", r.text);

r = await sub({ txn_type: "subscr_payment", subscr_id: S("biz"), txn_id: txn("biz-1"), payment_status: "Completed", item_number: "business", mc_gross: "70.00" });
check("a subscription payment of the wrong amount is rejected", purchase(txn("biz-1")) === "rejected" && subAccount() === "Personal/pending", r.text);

r = await sub({ txn_type: "subscr_payment", subscr_id: S("biz"), txn_id: txn("biz-2"), payment_status: "Completed", item_number: "business", mc_gross: "79.00" });
const days = paidUntilDays(txn("biz-2"));
check("the first payment grants Business for a year (plus grace) and activates the account",
  purchase(txn("biz-2")) === "completed" && subAccount() === "Business/active" && days >= 366 && days <= 370,
  `${r.text}; ${subAccount()}; ${days} days`);

r = await sub({ txn_type: "subscr_payment", subscr_id: S("biz"), txn_id: txn("biz-2"), payment_status: "Completed", item_number: "business", mc_gross: "79.00" });
check("a replayed payment changes nothing", sql(`select count(*) from purchases where txn_id = '${txn("biz-2")}';`) === "1", r.text);

r = await sub({ txn_type: "subscr_cancel", subscr_id: S("biz") });
check("cancelling keeps the plan until the paid year ends", subStatus(S("biz")) === "cancelled" && subAccount() === "Business/active", r.text);

r = await sub({ txn_type: "subscr_cancel", subscr_id: S("biz") });
check("a replayed cancellation is ignored", r.text === "duplicate", r.text);

r = await sub({ txn_type: "subscr_eot", subscr_id: S("biz") });
check("end of term takes the plan back", subStatus(S("biz")) === "ended" && subAccount() === "Personal/active", `${r.text}; ${subAccount()}`);

// A payment started outside the app carries no account email; the payer's
// PayPal address is used when an account has it.
r = await ipn({ custom: "", payer_email: SUB_EMAIL, txn_type: "subscr_signup", subscr_id: S("agency"), item_number: "agency", mc_amount3: "98.00", period3: "1 Y" });
r = await ipn({ custom: "", payer_email: SUB_EMAIL, txn_type: "subscr_payment", subscr_id: S("agency"), txn_id: txn("agency-1"), payment_status: "Completed", item_number: "agency", mc_gross: "98.00" });
check("matched by the payer's PayPal email when the app's email is missing", subAccount() === "Agency/active", `${r.text}; ${subAccount()}`);

r = await ipn({ txn_id: txn("agency-1-ref"), parent_txn_id: txn("agency-1"), payment_status: "Refunded", mc_gross: "-98.00" });
check("refunding a subscription payment withdraws the plan", purchase(txn("agency-1")) === "refunded" && subAccount() === "Personal/active", r.text);

// The owner switches unpaid accounts to Free: Personal becomes a real purchase.
sql(`update billing_config set unpaid_plan = 'Free'; select refresh_plans(true);`);
check("with unpaid accounts on Free, the subscriber drops to Free", subAccount() === "Free/active", subAccount());
r = await sub({ txn_type: "subscr_payment", subscr_id: S("personal"), txn_id: txn("personal-1"), payment_status: "Completed", item_number: "personal", mc_gross: "29.00" });
check("a Personal subscription then grants Personal", subAccount() === "Personal/active", `${r.text}; ${subAccount()}`);
sql(`update billing_config set unpaid_plan = 'Personal'; select refresh_plans(true);`);

// ----------------------------------------------------------------- cleanup
sql(`delete from purchases where txn_id like '${run}-%';
     delete from subscriptions where subscr_id like 'S-${run}-%';
     delete from webhook_events where id like '%${run}-%';
     delete from auth.users where email in ('${EMAIL}', '${SUB_EMAIL}');
     update plan_prices set amount = null, lifetime_amount = null;
     delete from rate_limits;`);

console.log(failures ? `\n${failures} webhook test(s) FAILED` : "\nAll webhook tests passed.");
process.exit(failures ? 1 : 0);
