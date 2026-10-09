#!/usr/bin/env node
/**
 * Team accounts, end to end through api.js against the local stack:
 * invitations, joining by sign-up and by login, permissions, the activity
 * log, seats per plan, removal, leaving, and per-item saves.
 *
 * Requires `supabase start` and the functions being served (see e2e.sh).
 *
 *   node scripts/team-test.mjs
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
  return win.DomainVaultAPI;
}

const tokenOf = (url) => /[?&]invite=([A-Za-z0-9_-]{43})/.exec(url || "")?.[1];

/** An active account on a plan, logged in. */
async function account(email, plan) {
  const api = browser();
  await api.call("registerUser", { email, password: PW });
  sql(`update profiles set status = 'active', plan_override = '${plan}' where email = '${email}';
       select recompute_plan(id) from profiles where email = '${email}';`);
  const r = await api.call("loginUser", { email, password: PW });
  if (!r.success) throw new Error(`login ${email}: ${r.message}`);
  return { api, id: r.user.id, email };
}

sql("delete from rate_limits;");
const ownerEmail = `team-owner-${stamp}@example.com`;
const staff1 = `team-staff1-${stamp}@example.com`;
const staff2 = `team-staff2-${stamp}@example.com`;
const third = `team-third-${stamp}@example.com`;
const soloEmail = `team-solo-${stamp}@example.com`;

try {
  // ======================================================== owner's vault
  console.log("--- owner, saving one item at a time ---");
  const owner = await account(ownerEmail, "Business");
  const O = owner.api;

  let r = await O.call("saveProvider", { provider: { name: "Namecheap", url: "https://namecheap.com", user: "acct", pass: "team-secret-1" } });
  ok("saveProvider creates a provider with a password", r.success && r.provider?.hasPassword === true && r.provider.pass === "");
  const providerId = r.provider?.id;
  r = await O.call("saveDomain", { domain: { name: "team-a.com", provider: "Namecheap", renewalDate: "2027-03-01", renewalPrice: 12 } });
  ok("saveDomain creates a domain", r.success && r.domain?.name === "team-a.com" && r.domain.renewalPrice === 12);
  const domainA = r.domain?.id;
  r = await O.call("saveDomain", { domain: { id: domainA, name: "team-a.com", provider: "Namecheap", renewalDate: "2027-03-02", renewalPrice: 15 } });
  ok("saveDomain updates it in place", r.success && r.domain?.id === domainA && r.domain.renewalDate === "2027-03-02");
  r = await O.call("saveDomain", { domain: { name: "TEAM-A.com", renewalDate: "2027-01-01" } });
  ok("a duplicate name is refused clearly", r.success === false && /already have a domain/i.test(r.message), r.message);
  r = await O.call("saveDomain", { domain: { name: "bad-date.com", renewalDate: "next year" } });
  ok("a bad date is refused clearly", r.success === false && /date/i.test(r.message), r.message);

  // ============================================================ inviting
  console.log("--- invitations ---");
  r = await O.call("inviteMember", { email: staff1, permissions: { editDomains: true, reminders: true } });
  ok("owner invites someone", r.success && tokenOf(r.inviteUrl), r.message);
  const token1 = tokenOf(r.inviteUrl);
  r = await O.call("inviteMember", { email: ownerEmail });
  ok("the owner's own address is refused", r.success === false && /owner/i.test(r.message), r.message);
  r = await O.call("getTeam", {});
  ok("the team lists the open invitation and counts its seat",
    r.success && r.invitations?.length === 1 && r.invitations[0].email === staff1 &&
      r.invitations[0].permissions.editDomains === true && r.seats.used === 2 && r.seats.limit === 5,
    JSON.stringify(r.seats));

  // A new person signs up through the link; approval is required, but the
  // owner's invitation activates the account.
  const S1 = browser();
  r = await S1.call("registerUser", { email: staff1, password: PW, inviteToken: token1 });
  ok("signing up through the invitation joins the team", r.success && r.joinedVault?.vaultId === owner.id, r.message);
  r = await S1.call("loginUser", { email: staff1, password: PW });
  ok("…and the new account can log in at once", r.success === true, r.message);
  const staff1Id = r.user?.id;

  r = await S1.call("getUserData", {});
  ok("their own vault is empty: team rows are not mixed into it", r.vault?.isOwner === true && r.domains.length === 0 && r.providers.length === 0);
  ok("the vault list has their own vault and the team's",
    r.vaults?.length === 2 && r.vaults[1].id === owner.id && r.vaults[1].active === true && r.vaults[1].ownerEmail === ownerEmail);

  r = await S1.call("getUserData", { vaultId: owner.id });
  ok("a member opens the team vault", r.vault?.id === owner.id && r.vault.isOwner === false &&
    r.domains.map((d) => d.name).join() === "team-a.com" && r.providers[0]?.hasPassword === true && r.providers[0].pass === "");
  ok("…with the permissions they were given", r.vault?.permissions.editDomains === true && r.vault.permissions.delete === false &&
    r.vault.permissions.passwords === false);
  ok("…and billing stays their own", r.purchases.length === 0 && r.plan !== "Business", r.plan);

  // ========================================================= permissions
  console.log("--- permissions ---");
  const V = { vaultId: owner.id };
  r = await S1.call("saveDomain", { ...V, domain: { name: "staff-added.com", provider: "Namecheap", renewalDate: "2027-04-01" } });
  ok("a member with 'edit domains' adds one", r.success && r.domain?.name === "staff-added.com", r.message);
  const staffDomain = r.domain?.id;
  r = await S1.call("deleteDomain", { ...V, id: staffDomain });
  ok("…but cannot delete without 'delete'", r.success === false && /permission/i.test(r.message), r.message);
  r = await S1.call("saveProvider", { ...V, provider: { name: "Porkbun" } });
  ok("…nor add providers without 'edit providers'", r.success === false && /permission/i.test(r.message), r.message);
  r = await S1.call("revealCredential", { ...V, providerId });
  ok("…nor see passwords without 'see passwords'", r.success === false && /permission/i.test(r.message), r.message);
  r = await S1.call("getTeam", V);
  ok("…nor open the team screen without 'manage'", r.success === false && /permission/i.test(r.message), r.message);
  r = await S1.call("inviteMember", { ...V, email: third });
  ok("…nor invite", r.success === false, r.message);
  r = await S1.call("revealCredential", { providerId });
  ok("a provider id from another vault is not found in your own", r.success === false);

  r = await O.call("updateMember", { memberId: staff1Id, permissions: { editDomains: true, delete: true, passwords: true, reminders: true } });
  ok("the owner changes a member's permissions", r.success === true, r.message);
  r = await S1.call("revealCredential", { ...V, providerId });
  ok("now the member can see the password", r.success && r.password === "team-secret-1");
  r = await S1.call("deleteDomain", { ...V, id: staffDomain });
  ok("…and delete", r.success === true);
  r = await O.call("getUserData", {});
  ok("the owner's vault shows the member's changes", r.domains.map((d) => d.name).join() === "team-a.com");

  const recipients = sql(`select email from team_reminder_recipients('${owner.id}')`);
  ok("the member chosen for reminders gets the owner's digest", recipients === staff1, recipients);

  r = await O.call("getTeam", {});
  const did = (r.activity || []).map((a) => `${a.actor === staff1 ? "staff" : "owner"}:${a.action}`);
  ok("the activity log shows what the member did, and team changes",
    ["staff:team.join", "staff:domain.add", "staff:domain.delete", "staff:password.reveal", "owner:team.invite", "owner:team.update"]
      .every((x) => did.includes(x)) && !did.includes("owner:domain.add"), did.join(","));
  ok("the member is listed as active", r.members?.[0]?.email === staff1 && r.members[0].active === true);

  // ============================================== a manager who isn't owner
  console.log("--- team managers ---");
  await O.call("updateMember", { memberId: staff1Id, permissions: { editDomains: true, manage: true } });
  r = await S1.call("inviteMember", { ...V, email: staff2, permissions: { passwords: true } });
  ok("a manager cannot give a permission they lack", r.success === false && /do not have yourself/i.test(r.message), r.message);
  r = await S1.call("updateMember", { ...V, memberId: staff1Id, permissions: { editDomains: true, manage: true, passwords: true } });
  ok("…nor change their own permissions", r.success === false && /own permissions/i.test(r.message), r.message);
  r = await S1.call("inviteMember", { ...V, email: staff2, permissions: { editDomains: true } });
  ok("…but can invite with what they have", r.success && tokenOf(r.inviteUrl), r.message);
  const token2 = tokenOf(r.inviteUrl);

  // An account that already exists, still waiting for approval, logs in
  // through the link.
  const S2 = browser();
  await S2.call("registerUser", { email: staff2, password: PW });
  r = await S2.call("loginUser", { email: staff2, password: PW, inviteToken: token2 });
  ok("logging in through the invitation joins and activates the account",
    r.success === true && r.joinedVault?.vaultId === owner.id, r.message);
  r = await S1.call("acceptInvitation", { token: token1 });
  ok("an invitation works once", r.success === false && /invalid|used|expired/i.test(r.message), r.message);

  // ====================================================== renames, links
  r = await O.call("saveProvider", { provider: { id: providerId, name: "Namecheap Inc", url: "https://namecheap.com", user: "acct" } });
  ok("renaming a provider keeps its password", r.success && r.provider?.hasPassword === true);
  r = await O.call("getUserData", {});
  ok("…and moves its domains to the new name", r.domains[0]?.provider === "Namecheap Inc", r.domains[0]?.provider);
  r = await O.call("deleteProvider", { id: providerId });
  ok("a provider with domains cannot be deleted", r.success === false && /still has domains/i.test(r.message), r.message);

  // ============================================================== seats
  console.log("--- seats ---");
  sql(`update profiles set plan_override = 'Start-up' where id = '${owner.id}'; select recompute_plan('${owner.id}');`);
  r = await S2.call("getUserData", V);
  ok("when the plan shrinks, the newest member loses access", r.success === false && /no longer have access/i.test(r.message), r.message);
  r = await S2.call("getUserData", {});
  ok("…and sees the team as unavailable", r.vaults?.[1]?.active === false);
  r = await S1.call("getUserData", V);
  ok("…while the oldest member keeps it", r.vault?.id === owner.id);
  r = await O.call("getTeam", {});
  ok("the owner sees who is over the seats", r.members?.[1]?.active === false && /seats/.test(r.members[1].inactiveReason || ""));
  r = await O.call("inviteMember", { email: third });
  ok("a full Start-up team cannot invite more", r.success === false && /2 people/.test(r.message), r.message);
  sql(`update profiles set plan_override = 'Business' where id = '${owner.id}'; select recompute_plan('${owner.id}');`);
  r = await S2.call("getUserData", V);
  ok("upgrading gives the access back", r.vault?.id === owner.id);

  const solo = await account(soloEmail, "Personal");
  r = await solo.api.call("inviteMember", { email: third });
  ok("a Personal plan is for one person", r.success === false && /one person/i.test(r.message), r.message);

  // ============================================ cancelling, leaving, removal
  console.log("--- leaving and removal ---");
  r = await O.call("inviteMember", { email: third });
  const token3 = tokenOf(r.inviteUrl);
  r = await O.call("cancelInvitation", { email: third });
  ok("an invitation can be cancelled", r.success === true);
  r = await solo.api.call("acceptInvitation", { token: token3 });
  ok("…and its link no longer works", r.success === false, r.message);

  r = await S2.call("leaveTeam", V);
  ok("a member can leave", r.success === true);
  r = await S2.call("getUserData", {});
  ok("…and the team is gone from their list", r.vaults?.length === 1);

  r = await O.call("removeMember", { memberId: staff1Id });
  ok("the owner removes a member", r.success === true);
  r = await S1.call("getUserData", V);
  ok("…who loses access at once", r.success === false && /no longer have access/i.test(r.message), r.message);
  r = await S1.call("saveDomain", { ...V, domain: { name: "after-removal.com" } });
  ok("…and cannot write to the vault", r.success === false);
} catch (err) {
  failures++;
  console.log("ERROR", err.message);
} finally {
  sql(`delete from auth.users where email in ('${ownerEmail}', '${staff1}', '${staff2}', '${third}', '${soloEmail}');
       delete from rate_limits;`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll team flows passed.");
process.exit(failures ? 1 : 0);
