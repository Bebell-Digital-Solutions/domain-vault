#!/usr/bin/env node
/**
 * ============================================================================
 * Domain Vault — one-time migration from the Google Sheets backend
 * ============================================================================
 *
 * Usage:
 *   node scripts/import-from-sheets.mjs export.json            # dry run
 *   node scripts/import-from-sheets.mjs export.json --commit    # write
 *
 * Produce export.json by running the snippet in README.md ("Exporting the old
 * sheet") inside the existing Apps Script project.
 *
 * Deliberate omissions:
 *
 *   * User passwords are NOT imported. They sat in a spreadsheet in plaintext
 *     and behind a public endpoint, so they must all be considered
 *     compromised. Each account is created with a random password and gets a
 *     recovery link instead.
 *
 *   * Registrar passwords are NOT imported for the same reason. Carrying them
 *     over would launder known-exposed credentials into the new system and
 *     give everyone false confidence. Users re-enter the ones they still want
 *     stored, after rotating them at the registrar.
 *
 * The script is idempotent: existing accounts are skipped, and domains and
 * providers are matched on name, so a re-run does not duplicate rows.
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const [, , inputPath, ...flags] = process.argv;
const COMMIT = flags.includes("--commit");

if (!inputPath) {
  console.error("usage: import-from-sheets.mjs <export.json> [--commit]");
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const raw = JSON.parse(readFileSync(inputPath, "utf8"));
const rows = (name) => Array.isArray(raw[name]) ? raw[name] : [];

const norm = (v) => (typeof v === "string" ? v.trim() : v ?? "");
const email = (v) => norm(v).toLowerCase();

const PLANS = new Set(["Personal", "Start-up", "Business", "Agency"]);
const STATUSES = new Set(["pending", "active", "suspended"]);

/** Sheet dates arrive as ISO strings or Date-like text; normalise or drop. */
function toDate(value) {
  const s = norm(value);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function toMoney(value) {
  const n = Number(String(value ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

const stats = {
  usersCreated: 0, usersExisting: 0, usersFailed: 0,
  domains: 0, providers: 0, settings: 0,
  providerPasswordsSkipped: 0, recoveryLinks: 0,
};

console.log(COMMIT ? "=== COMMIT MODE ===" : "=== DRY RUN (pass --commit to write) ===");

// ---------------------------------------------------------------------------
// 1. Accounts
// ---------------------------------------------------------------------------
const userIdByEmail = new Map();

for (const u of rows("Users")) {
  const addr = email(u.Email);
  if (!addr) continue;

  const { data: existing } = await db
    .from("profiles").select("id").eq("email", addr).maybeSingle();

  if (existing) {
    userIdByEmail.set(addr, existing.id);
    stats.usersExisting++;
    continue;
  }

  if (!COMMIT) {
    userIdByEmail.set(addr, `dry-run-${addr}`);
    stats.usersCreated++;
    continue;
  }

  const { data, error } = await db.auth.admin.createUser({
    email: addr,
    // Random and immediately discarded: the user sets their own via recovery.
    password: crypto.randomUUID() + crypto.randomUUID(),
    email_confirm: true,
    user_metadata: { phone: norm(u.Phone), location: norm(u.Location) },
  });

  if (error || !data?.user) {
    console.error(`  ! ${addr}: ${error?.message ?? "unknown error"}`);
    stats.usersFailed++;
    continue;
  }

  userIdByEmail.set(addr, data.user.id);
  stats.usersCreated++;

  // handle_new_user already made the profile; apply the sheet's plan/status.
  const plan = PLANS.has(norm(u.Plan)) ? norm(u.Plan) : "Personal";
  const status = STATUSES.has(String(norm(u.Status)).toLowerCase())
    ? String(norm(u.Status)).toLowerCase()
    : "pending";

  await db.from("profiles").update({
    plan,
    status,
    phone: norm(u.Phone) || null,
    location: norm(u.Location) || null,
  }).eq("id", data.user.id);

  const { data: link, error: linkError } = await db.auth.admin.generateLink({
    type: "recovery",
    email: addr,
  });
  if (!linkError && link) stats.recoveryLinks++;
}

// ---------------------------------------------------------------------------
// 2. Providers (names and usernames only — never the stored passwords)
// ---------------------------------------------------------------------------
for (const p of rows("Providers")) {
  const owner = userIdByEmail.get(email(p.UserEmail));
  const name = norm(p.Name);
  if (!owner || !name) continue;

  if (norm(p.Pass)) stats.providerPasswordsSkipped++;
  stats.providers++;
  if (!COMMIT) continue;

  const { error } = await db.from("providers").upsert({
    user_id: owner,
    name,
    url: norm(p.URL) || null,
    username: norm(p.User) || null,
    uid: norm(p.UID) || null,
  }, { onConflict: "user_id,name", ignoreDuplicates: false });

  if (error) console.error(`  ! provider ${name}: ${error.message}`);
}

// ---------------------------------------------------------------------------
// 3. Domains
// ---------------------------------------------------------------------------
for (const d of rows("Domains")) {
  const owner = userIdByEmail.get(email(d.UserEmail));
  const name = norm(d.Name).toLowerCase();
  if (!owner || !name) continue;

  stats.domains++;
  if (!COMMIT) continue;

  const { error } = await db.from("domains").upsert({
    user_id: owner,
    name,
    provider_name: norm(d.Provider) || null,
    purchase_date: toDate(d.PurchaseDate),
    renewal_date: toDate(d.RenewalDate),
    purchase_price: toMoney(d.PurchasePrice),
    renewal_price: toMoney(d.RenewalPrice),
    auto_renew: String(d.AutoRenew).toLowerCase() === "true",
  }, { onConflict: "user_id,name", ignoreDuplicates: false });

  if (error) console.error(`  ! domain ${name}: ${error.message}`);
}

// ---------------------------------------------------------------------------
// 4. Settings (profile pictures are left behind: they were megabyte-sized
//    base64 blobs in a cell. Users re-upload, and new ones go to Storage.)
// ---------------------------------------------------------------------------
for (const s of rows("Settings")) {
  const owner = userIdByEmail.get(email(s.UserEmail));
  if (!owner) continue;

  stats.settings++;
  if (!COMMIT) continue;

  const { error } = await db.from("settings").upsert({
    user_id: owner,
    theme: norm(s.Theme) || "dark",
    language: norm(s.Language) || "en",
    username: norm(s.Username) || null,
  }, { onConflict: "user_id" });

  if (error) console.error(`  ! settings: ${error.message}`);
}

// ---------------------------------------------------------------------------
console.log("\n--- summary ---");
for (const [k, v] of Object.entries(stats)) console.log(`${k.padEnd(26)} ${v}`);

if (stats.providerPasswordsSkipped > 0) {
  console.log(
    `\n${stats.providerPasswordsSkipped} registrar password(s) were intentionally not imported.`,
  );
  console.log("Those credentials were exposed by the old backend and should be");
  console.log("rotated at the registrar, not carried across.");
}

if (!COMMIT) console.log("\nDry run only. Re-run with --commit to apply.");
