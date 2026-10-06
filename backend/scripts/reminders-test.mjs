#!/usr/bin/env node
/**
 * End-to-end test of the daily reminder sweep against the local stack.
 *
 * Requires the functions to be served with a working RESEND_API_KEY and
 * CRON_SECRET (scripts/e2e.sh does this). Mail goes to Resend's test inbox,
 * delivered@resend.dev, so no real person is emailed.
 *
 *   node scripts/reminders-test.mjs
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = "http://127.0.0.1:54321/functions/v1";
const EMAIL = "delivered@resend.dev";
const envFile = process.env.REMINDER_ENV ||
  fileURLToPath(new URL("../.env", import.meta.url));
const CRON = (readFileSync(envFile, "utf8").match(/^CRON_SECRET=(.+)$/m) || [])[1];
let failures = 0;

const sql = (q) =>
  execSync("docker exec -i supabase_db_backend psql -U postgres -qtA", { input: q }).toString().trim();
const ok = (l, c, x = "") => { if (!c) failures++; console.log(`${c ? "PASS" : "FAIL"}  ${l}${x ? "  " + x : ""}`); };
const sweep = async () => {
  const res = await fetch(`${BASE}/reminders`, { method: "POST", headers: { "x-cron-secret": CRON } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const notificationsFor = (email) =>
  sql(`select coalesce(string_agg(domain_name || ':' || diff_days, ',' order by domain_name), '')
         from notifications n join profiles p on p.id = n.user_id where p.email = '${email}';`);
const notifications = () => notificationsFor(EMAIL);

// ------------------------------------------------------------------ setup
sql(`delete from auth.users where email = '${EMAIL}';`);
sql(`insert into auth.users (id, email) values (gen_random_uuid(), '${EMAIL}');`);
sql(`update profiles set status = 'active' where email = '${EMAIL}';`);
sql(`insert into domains (user_id, name, renewal_date, renewal_price, auto_renew, provider_name)
     select id, 'soon.com',   current_date + 1,  12.99, false, 'Namecheap' from profiles where email = '${EMAIL}';
     insert into domains (user_id, name, renewal_date, renewal_price, auto_renew)
     select id, 'later.com',  current_date + 20, 9.99,  true from profiles where email = '${EMAIL}';
     insert into domains (user_id, name, renewal_date)
     select id, 'distant.com', current_date + 200 from profiles where email = '${EMAIL}';`);

// ------------------------------------------------------------------- run
let r = await sweep();
ok("sweep runs", r.status === 200, JSON.stringify(r.body));
ok("both due domains are picked up, the far-off one is not",
  r.body.due === 2 && r.body.sent === 2, JSON.stringify(r.body));
ok("the two domains arrive as ONE digest, not two emails",
  r.body.recipients === 1, `recipients=${r.body.recipients}`);
ok("milestones recorded: 1 day for soon.com, 30 for later.com",
  notifications() === "later.com:30,soon.com:1", notifications());

r = await sweep();
ok("a second run the same day sends nothing", r.body.due === 0 && r.body.sent === 0, JSON.stringify(r.body));

// ------------------------------------------- the renewal-cycle regression
sql(`update domains set renewal_date = current_date + 30
      where name = 'soon.com' and user_id = (select id from profiles where email = '${EMAIL}');`);
r = await sweep();
ok("renewing a domain starts a fresh cycle", r.body.sent === 1, JSON.stringify(r.body));

// ------------------------------------------------ opt-out must be honoured
sql(`update settings set reminders_enabled = false
      where user_id = (select id from profiles where email = '${EMAIL}');`);
sql(`update domains set renewal_date = current_date + 7
      where name = 'distant.com' and user_id = (select id from profiles where email = '${EMAIL}');`);
r = await sweep();
ok("switching reminders off silences them", r.body.due === 0, JSON.stringify(r.body));

// ------------------------------------- a failed send must not be recorded
sql(`update settings set reminders_enabled = true
      where user_id = (select id from profiles where email = '${EMAIL}');`);
// Malformed on purpose: Resend refuses it outright, so the send fails without
// anything being sent (a real bounce would count against the domain).
const BOUNCE = 'not-an-email-address';
sql(`update profiles set email = '${BOUNCE}' where email = '${EMAIL}';`);
// Give the user something new to be reminded about, then watch it fail.
sql(`update domains set renewal_date = current_date + 7
      where name = 'distant.com' and user_id = (select id from profiles where email = '${BOUNCE}');`);
const before = notificationsFor(BOUNCE);
r = await sweep();
const after = notificationsFor(BOUNCE);
ok("a send that fails is not recorded as delivered, so tomorrow retries",
  r.body.failed > 0 && after === before, `failed=${r.body.failed}`);

// --------------------------------------------------------------- cleanup
sql(`delete from auth.users where email in ('${EMAIL}', '${BOUNCE}');`);
console.log(failures ? `\n${failures} reminder check(s) FAILED` : "\nAll reminder flows passed.");
process.exit(failures ? 1 : 0);
