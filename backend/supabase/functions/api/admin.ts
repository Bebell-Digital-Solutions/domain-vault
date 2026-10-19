// ============================================================================
// Admin actions
//
// Replaces "edit the Google Sheet by hand" and, later, "run SQL with the
// service role key". Every action here:
//   * is reached only after requireAdmin() has verified the caller's JWT and
//     their is_admin flag;
//   * validates its input;
//   * writes an admin_audit_log row recording who changed what, before and
//     after.
// ============================================================================

import { type Caller, HttpError, serviceClient } from "../_shared/db.ts";
import { BadRequest, isUuid, str } from "../_shared/validate.ts";
import {
  type Brand,
  effectiveTemplate,
  loadEmailSettings,
  renderEmail,
  sendTemplate,
  type Template,
  TEMPLATES,
} from "../_shared/email.ts";
import { sendEmail } from "../_shared/notify.ts";

const PLANS = ["Free", "Personal", "Start-up", "Business", "Agency"] as const;
const PAID_PLANS = ["Personal", "Start-up", "Business", "Agency"] as const;
const UNPAID_PLANS = ["Free", "Personal"] as const;
const STATUSES = ["pending", "active", "suspended"] as const;
const PURCHASE_STATUSES = [
  "completed", "pending", "refunded", "reversed", "rejected", "unmatched", "failed",
] as const;

const SITE_URL = Deno.env.get("SITE_URL") ?? "";

export async function audit(
  admin: Caller,
  action: string,
  target: { id: string | null; email: string | null } | null,
  details: Record<string, unknown>,
) {
  const { error } = await serviceClient().from("admin_audit_log").insert({
    admin_id: admin.id,
    admin_email: admin.email,
    target_user_id: target?.id ?? null,
    target_email: target?.email ?? null,
    action,
    details,
  });
  // An admin change that cannot be audited should not silently succeed.
  if (error) throw new HttpError(500, `Audit log write failed: ${error.message}`);
}

function isoDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}

// ---------------------------------------------------------------------------

export async function adminOverview() {
  const db = serviceClient();

  const [profiles, domains, purchases, subscriptions] = await Promise.all([
    db.from("profiles").select("status, plan"),
    db.from("domains").select("id", { count: "exact", head: true }),
    db.from("purchases").select("status, amount, currency"),
    db.from("subscriptions").select("status"),
  ]);
  if (profiles.error) throw new HttpError(500, profiles.error.message);

  const byStatus: Record<string, number> = {};
  const byPlan: Record<string, number> = {};
  for (const p of profiles.data ?? []) {
    byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
    byPlan[p.plan] = (byPlan[p.plan] ?? 0) + 1;
  }

  const revenue: Record<string, number> = {};
  let needsAttention = 0;
  for (const p of purchases.data ?? []) {
    if (p.status === "completed" && p.currency) {
      revenue[p.currency] = Math.round(((revenue[p.currency] ?? 0) + Number(p.amount ?? 0)) * 100) / 100;
    }
    if (p.status === "rejected" || p.status === "unmatched") needsAttention++;
  }

  return {
    success: true,
    users: { total: profiles.data?.length ?? 0, byStatus, byPlan },
    domains: domains.count ?? 0,
    sales: {
      completed: (purchases.data ?? []).filter((p) => p.status === "completed").length,
      revenue,
      needsAttention,
    },
    subscriptions: {
      active: (subscriptions.data ?? []).filter((s) => s.status === "active").length,
      cancelled: (subscriptions.data ?? []).filter((s) => s.status === "cancelled").length,
    },
  };
}

// deno-lint-ignore no-explicit-any
export async function adminListUsers(p: any) {
  const db = serviceClient();
  const limit = Math.min(Math.max(Number(p?.limit) || 50, 1), 200);
  const offset = Math.max(Number(p?.offset) || 0, 0);

  let query = db
    .from("profiles")
    .select("id, email, phone, location, status, plan, plan_override, is_admin, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (STATUSES.includes(p?.status)) query = query.eq("status", p.status);
  const search = str(p?.search, 100);
  // Escape PostgREST's pattern metacharacters so the search is literal.
  if (search) query = query.ilike("email", `%${search.replace(/[%_\\,()]/g, "")}%`);

  const { data, error, count } = await query;
  if (error) throw new HttpError(500, error.message);

  const ids = (data ?? []).map((u) => u.id);
  const counts = new Map<string, number>();
  if (ids.length) {
    const { data: rows, error: countError } = await db.rpc("admin_domain_counts", { p_users: ids });
    if (countError) throw new HttpError(500, countError.message);
    for (const r of rows ?? []) counts.set(r.user_id, Number(r.domain_count));
  }

  // Each user's current subscription (active, else the latest cancelled one)
  // and how long what they paid for runs.
  const subs = new Map<string, { plan: string; status: string; paid_until: string | null }>();
  if (ids.length) {
    const [s, paid] = await Promise.all([
      db.from("subscriptions").select("user_id, plan, status, updated_at")
        .in("user_id", ids).in("status", ["active", "cancelled"]).order("updated_at", { ascending: false }),
      db.from("purchases").select("user_id, paid_until")
        .in("user_id", ids).eq("kind", "subscription").eq("status", "completed"),
    ]);
    const until = new Map<string, string>();
    for (const r of paid.data ?? []) {
      if (r.paid_until && (!until.has(r.user_id) || r.paid_until > until.get(r.user_id)!)) {
        until.set(r.user_id, r.paid_until);
      }
    }
    for (const r of s.data ?? []) {
      const current = subs.get(r.user_id);
      if (!current || (current.status !== "active" && r.status === "active")) {
        subs.set(r.user_id, { plan: r.plan, status: r.status, paid_until: until.get(r.user_id) ?? null });
      }
    }
  }

  // People each user has let into their vault, and teams they belong to.
  const teamSize = new Map<string, number>();
  const memberOf = new Map<string, number>();
  if (ids.length) {
    const [owned, joined] = await Promise.all([
      db.from("team_members").select("owner_id").in("owner_id", ids),
      db.from("team_members").select("member_id").in("member_id", ids),
    ]);
    for (const r of owned.data ?? []) teamSize.set(r.owner_id, (teamSize.get(r.owner_id) ?? 0) + 1);
    for (const r of joined.data ?? []) memberOf.set(r.member_id, (memberOf.get(r.member_id) ?? 0) + 1);
  }

  return {
    success: true,
    total: count ?? 0,
    users: (data ?? []).map((u) => ({
      ...u,
      domain_count: counts.get(u.id) ?? 0,
      subscription: subs.get(u.id) ?? null,
      team_members: teamSize.get(u.id) ?? 0,
      member_of: memberOf.get(u.id) ?? 0,
    })),
  };
}

// deno-lint-ignore no-explicit-any
export async function adminUpdateUser(admin: Caller, p: any) {
  if (!isUuid(p?.userId)) throw new BadRequest("userId must be a uuid");
  const db = serviceClient();

  const { data: before, error } = await db
    .from("profiles")
    .select("id, email, status, plan, plan_override, is_admin")
    .eq("id", p.userId)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!before) throw new HttpError(404, "User not found.");

  const changes: Record<string, unknown> = {};

  if (p.status !== undefined) {
    if (!STATUSES.includes(p.status)) throw new BadRequest("invalid status");
    changes.status = p.status;
  }
  if (p.planOverride !== undefined) {
    const value = p.planOverride === "" ? null : p.planOverride;
    if (value !== null && !PLANS.includes(value)) throw new BadRequest("invalid plan");
    changes.plan_override = value;
  }
  if (p.isAdmin !== undefined) {
    if (typeof p.isAdmin !== "boolean") throw new BadRequest("isAdmin must be a boolean");
    changes.is_admin = p.isAdmin;
  }

  if (Object.keys(changes).length === 0) throw new BadRequest("Nothing to change.");

  // An admin must not be able to lock themselves out by accident.
  if (before.id === admin.id) {
    if (changes.is_admin === false) throw new BadRequest("You cannot remove your own admin rights.");
    if (changes.status && changes.status !== "active") {
      throw new BadRequest("You cannot suspend or deactivate your own account.");
    }
  }

  const { error: updateError } = await db.from("profiles").update(changes).eq("id", before.id);
  if (updateError) throw new HttpError(500, updateError.message);

  // plan is derived; re-derive it whenever the override moves.
  if ("plan_override" in changes) {
    const { error: rpcError } = await db.rpc("recompute_plan", { p_user: before.id });
    if (rpcError) throw new HttpError(500, rpcError.message);
  }

  const { data: after } = await db
    .from("profiles")
    .select("id, email, phone, location, status, plan, plan_override, is_admin, created_at")
    .eq("id", before.id)
    .single();

  await audit(admin, "update_user", before, {
    before: {
      status: before.status, plan: before.plan,
      plan_override: before.plan_override, is_admin: before.is_admin,
    },
    after: {
      status: after?.status, plan: after?.plan,
      plan_override: after?.plan_override, is_admin: after?.is_admin,
    },
  });

  // The welcome email promised this message.
  if (before.status !== "active" && after?.status === "active") {
    await sendTemplate(before.email, "account_activated", { email: before.email });
  }

  return { success: true, user: after };
}

// deno-lint-ignore no-explicit-any
export async function adminSales(p: any) {
  const db = serviceClient();
  let query = db
    .from("purchases")
    .select("id, txn_id, email, payer_email, plan, amount, currency, status, reason, source, kind, subscr_id, paid_until, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(500);

  const from = isoDate(p?.from);
  const to = isoDate(p?.to);
  if (from) query = query.gte("created_at", `${from}T00:00:00Z`);
  if (to) query = query.lte("created_at", `${to}T23:59:59Z`);
  if (PURCHASE_STATUSES.includes(p?.status)) query = query.eq("status", p.status);

  const { data, error } = await query;
  if (error) throw new HttpError(500, error.message);

  // Totals are per currency — never add USD to JPY.
  const totals: Record<string, { completed: number; refunded: number; count: number }> = {};
  const byPlan: Record<string, number> = {};
  for (const row of data ?? []) {
    if (!row.currency) continue;
    const t = totals[row.currency] ??= { completed: 0, refunded: 0, count: 0 };
    const amount = Number(row.amount ?? 0);
    if (row.status === "completed") {
      t.completed = Math.round((t.completed + amount) * 100) / 100;
      t.count++;
      if (row.plan) byPlan[row.plan] = (byPlan[row.plan] ?? 0) + 1;
    }
    if (row.status === "refunded" || row.status === "reversed") {
      t.refunded = Math.round((t.refunded + amount) * 100) / 100;
    }
  }

  return { success: true, purchases: data ?? [], totals, byPlan };
}

async function billingConfig() {
  const { data, error } = await serviceClient()
    .from("billing_config").select("unpaid_plan, require_approval").eq("id", true).single();
  if (error) throw new HttpError(500, error.message);
  return { unpaidPlan: data.unpaid_plan, requireApproval: data.require_approval };
}

export async function adminGetPrices() {
  const { data, error } = await serviceClient()
    .from("plan_prices").select("plan, amount, lifetime_amount, currency, updated_at").order("plan");
  if (error) throw new HttpError(500, error.message);
  return {
    success: true,
    prices: (data ?? []).map((r) => ({
      plan: r.plan,
      amount: r.amount === null ? null : Number(r.amount),
      lifetimeAmount: r.lifetime_amount === null ? null : Number(r.lifetime_amount),
      currency: r.currency,
      updated_at: r.updated_at,
    })),
    config: await billingConfig(),
  };
}

/** A price field: a positive number, null/"" to take it off sale, undefined to leave it alone. */
function priceField(value: unknown, label: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 100000) {
    throw new BadRequest(`${label} must be a positive number, or empty to take it off sale`);
  }
  return Math.round(n * 100) / 100;
}

// deno-lint-ignore no-explicit-any
export async function adminSetPrice(admin: Caller, p: any) {
  if (!PAID_PLANS.includes(p?.plan)) {
    throw new BadRequest("plan must be Personal, Start-up, Business or Agency");
  }
  const amount = priceField(p.amount, "The yearly price");
  const lifetime = priceField(p.lifetimeAmount, "The lifetime price");
  const currency = typeof p.currency === "string" ? p.currency.trim().toUpperCase() : "USD";
  if (!/^[A-Z]{3}$/.test(currency)) throw new BadRequest("currency must be a 3-letter code, e.g. USD");

  const db = serviceClient();
  const { data: before } = await db
    .from("plan_prices").select("amount, lifetime_amount, currency").eq("plan", p.plan).maybeSingle();

  const row: Record<string, unknown> = { plan: p.plan, currency };
  if (amount !== undefined) row.amount = amount;
  if (lifetime !== undefined) row.lifetime_amount = lifetime;

  const { error } = await db.from("plan_prices").upsert(row, { onConflict: "plan" });
  if (error) throw new HttpError(500, error.message);

  await audit(admin, "set_price", null, {
    plan: p.plan,
    before,
    after: {
      amount: amount === undefined ? before?.amount ?? null : amount,
      lifetime_amount: lifetime === undefined ? before?.lifetime_amount ?? null : lifetime,
      currency,
    },
  });

  return adminGetPrices();
}

/**
 * The owner's two plan decisions: what an account without a paid plan gets
 * (Personal, free; or Free, no domains), and whether new sign-ups wait for
 * approval. Changing the first re-derives every account's plan.
 */
// deno-lint-ignore no-explicit-any
export async function adminSetBillingConfig(admin: Caller, p: any) {
  const changes: Record<string, unknown> = {};
  if (p?.unpaidPlan !== undefined) {
    if (!UNPAID_PLANS.includes(p.unpaidPlan)) throw new BadRequest("unpaidPlan must be Free or Personal");
    changes.unpaid_plan = p.unpaidPlan;
  }
  if (p?.requireApproval !== undefined) {
    if (typeof p.requireApproval !== "boolean") throw new BadRequest("requireApproval must be true or false");
    changes.require_approval = p.requireApproval;
  }
  if (Object.keys(changes).length === 0) throw new BadRequest("Nothing to change.");

  const db = serviceClient();
  const before = await billingConfig();
  const { error } = await db.from("billing_config").update(changes).eq("id", true);
  if (error) throw new HttpError(500, error.message);

  if (changes.unpaid_plan !== undefined && changes.unpaid_plan !== before.unpaidPlan) {
    const { error: rpcError } = await db.rpc("refresh_plans", { p_all: true });
    if (rpcError) throw new HttpError(500, rpcError.message);
  }

  const after = await billingConfig();
  await audit(admin, "set_billing_config", null, { before, after });
  return { success: true, config: after };
}

// deno-lint-ignore no-explicit-any
export async function adminAudit(p: any) {
  const limit = Math.min(Math.max(Number(p?.limit) || 100, 1), 500);
  const { data, error } = await serviceClient()
    .from("admin_audit_log")
    .select("id, admin_email, target_email, action, details, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new HttpError(500, error.message);
  return { success: true, entries: data ?? [] };
}

// ---------------------------------------------------------------------------
// Tools & recommendations (catalog_items)
// ---------------------------------------------------------------------------

const CATALOG_KINDS = ["provider", "tool"] as const;

export async function adminListCatalog() {
  const { data, error } = await serviceClient()
    .from("catalog_items")
    .select("id, kind, name, description, url, icon, rating, tags, sort, active, updated_at")
    .order("sort").order("name");
  if (error) throw new HttpError(500, error.message);
  return { success: true, items: (data ?? []).map((r) => ({ ...r, rating: Number(r.rating) })) };
}

/** Create (no id) or update (id) one item. Fields are validated here and again by table constraints. */
// deno-lint-ignore no-explicit-any
export async function adminSaveCatalogItem(admin: Caller, p: any) {
  const item = p?.item ?? {};
  const name = str(item.name, 80);
  if (!name) throw new BadRequest("Name is required.");
  const url = str(item.url, 500);
  if (!url || !/^https?:\/\/[^\s"<>]+$/.test(url)) throw new BadRequest("URL must start with https:// (or http://).");
  if (!CATALOG_KINDS.includes(item.kind)) throw new BadRequest("Kind must be provider or tool.");
  const icon = (str(item.icon, 40) ?? "globe").toLowerCase();
  if (!/^[a-z0-9-]{1,40}$/.test(icon)) throw new BadRequest("Icon must be a Lucide icon name, e.g. globe or shield-check.");
  const rating = item.rating === undefined || item.rating === "" ? 5 : Number(item.rating);
  if (!Number.isFinite(rating) || rating < 0 || rating > 5) throw new BadRequest("Rating must be between 0 and 5.");
  const rawTags: unknown[] = Array.isArray(item.tags) ? item.tags : String(item.tags ?? "").split(",");
  const tags = [...new Set(rawTags.map((t) => String(t).trim().toLowerCase().replace(/\s+/g, "-")).filter(Boolean))];
  if (tags.length > 8 || tags.some((t) => !/^[a-z0-9-]{1,30}$/.test(t))) {
    throw new BadRequest("Up to 8 tags, each made of letters, digits and dashes.");
  }
  const sort = item.sort === undefined || item.sort === "" ? 100 : Math.round(Number(item.sort));
  if (!Number.isFinite(sort)) throw new BadRequest("Order must be a number.");

  const row = {
    kind: item.kind,
    name,
    description: str(item.description, 200) ?? "",
    url,
    icon,
    rating: Math.round(rating * 10) / 10,
    tags,
    sort,
    active: item.active !== false,
  };

  const db = serviceClient();
  let before: Record<string, unknown> | null = null;
  let saved: Record<string, unknown> | null = null;
  if (item.id) {
    if (!isUuid(item.id)) throw new BadRequest("id must be a uuid");
    ({ data: before } = await db.from("catalog_items").select("*").eq("id", item.id).maybeSingle());
    if (!before) throw new HttpError(404, "Item not found.");
    const { data, error } = await db.from("catalog_items").update(row).eq("id", item.id).select().single();
    if (error) throw new HttpError(400, error.message);
    saved = data;
  } else {
    const { data, error } = await db.from("catalog_items").insert(row).select().single();
    if (error) throw new HttpError(400, error.message);
    saved = data;
  }

  await audit(admin, item.id ? "update_catalog_item" : "add_catalog_item", null, { before, after: saved });
  return adminListCatalog();
}

// deno-lint-ignore no-explicit-any
export async function adminDeleteCatalogItem(admin: Caller, p: any) {
  if (!isUuid(p?.id)) throw new BadRequest("id must be a uuid");
  const db = serviceClient();
  const { data: before } = await db.from("catalog_items").select("*").eq("id", p.id).maybeSingle();
  if (!before) throw new HttpError(404, "Item not found.");
  const { error } = await db.from("catalog_items").delete().eq("id", p.id);
  if (error) throw new HttpError(500, error.message);
  await audit(admin, "delete_catalog_item", null, { before });
  return adminListCatalog();
}

// ---------------------------------------------------------------------------
// Domain search: registrars (with their affiliate links) and prices
// ---------------------------------------------------------------------------

const TLD_RE = /^[a-z0-9-]{2,63}(\.[a-z0-9-]{2,63})?$/;
// Extensions offered in the price editor even before they have prices.
const COMMON_TLDS = ["com", "net", "org", "io", "co", "ai", "app", "dev", "xyz", "online", "tech", "store", "site", "me", "us", "uk", "co.uk", "de", "es", "ca"];

function clientRegistrar(r: Record<string, unknown>) {
  return {
    id: r.id,
    name: r.name,
    website: r.website,
    urlTemplate: r.url_template,
    whois: r.whois,
    ssl: r.ssl,
    notes: r.notes,
    active: r.active,
    sort: r.sort,
  };
}

export async function adminListRegistrars() {
  const db = serviceClient();
  const [{ data: regs, error }, { data: prices }] = await Promise.all([
    db.from("registrars").select("*").order("sort").order("name"),
    db.from("registrar_prices").select("tld, registrar_id, source"),
  ]);
  if (error) throw new HttpError(500, error.message);
  const counts = new Map<string, number>();
  const manualTlds = new Set<string>();
  for (const p of prices ?? []) {
    counts.set(p.registrar_id, (counts.get(p.registrar_id) ?? 0) + 1);
    if (p.source === "manual") manualTlds.add(p.tld);
  }
  return {
    success: true,
    registrars: (regs ?? []).map((r) => ({ ...clientRegistrar(r), priceCount: counts.get(r.id) ?? 0 })),
    // Extensions with prices entered by hand first, then common ones.
    tlds: [...new Set([...[...manualTlds].sort(), ...COMMON_TLDS])],
  };
}

// deno-lint-ignore no-explicit-any
export async function adminSaveRegistrar(admin: Caller, p: any) {
  const r = p?.registrar ?? {};
  const name = str(r.name, 60);
  if (!name) throw new BadRequest("Name is required.");
  const website = (str(r.website, 100) ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9.-]{3,100}$/.test(website) || !website.includes(".")) throw new BadRequest("Website must be a domain, e.g. porkbun.com.");
  const urlTemplate = str(r.urlTemplate, 600);
  if (!urlTemplate || !/^https:\/\/[^\s"<>]+$/.test(urlTemplate)) {
    throw new BadRequest("The buy link must start with https://. Put {domain} where the searched name goes.");
  }
  const sort = r.sort === undefined || r.sort === "" ? 100 : Math.round(Number(r.sort));
  if (!Number.isFinite(sort)) throw new BadRequest("Order must be a number.");
  const row = {
    name,
    website,
    url_template: urlTemplate,
    whois: str(r.whois, 60) ?? "",
    ssl: str(r.ssl, 60) ?? "",
    notes: str(r.notes, 200) ?? "",
    active: r.active !== false,
    sort,
  };

  const db = serviceClient();
  const id = typeof r.id === "string" && r.id ? r.id : name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  if (!/^[a-z0-9-]{2,40}$/.test(id)) throw new BadRequest("Name must contain letters or digits.");
  const { data: before } = await db.from("registrars").select("*").eq("id", id).maybeSingle();
  if (!r.id && before) throw new HttpError(409, `A registrar called ${before.name} already exists.`);
  if (r.id && !before) throw new HttpError(404, "Registrar not found.");

  const { data: saved, error } = before
    ? await db.from("registrars").update(row).eq("id", id).select().single()
    : await db.from("registrars").insert({ id, ...row }).select().single();
  if (error) throw new HttpError(400, error.message);
  await audit(admin, before ? "update_registrar" : "add_registrar", null, { before, after: saved });
  return adminListRegistrars();
}

// deno-lint-ignore no-explicit-any
export async function adminDeleteRegistrar(admin: Caller, p: any) {
  if (typeof p?.id !== "string" || !/^[a-z0-9-]{2,40}$/.test(p.id)) throw new BadRequest("id is required");
  const db = serviceClient();
  const { data: before } = await db.from("registrars").select("*").eq("id", p.id).maybeSingle();
  if (!before) throw new HttpError(404, "Registrar not found.");
  const { error } = await db.from("registrars").delete().eq("id", p.id);
  if (error) throw new HttpError(500, error.message);
  await audit(admin, "delete_registrar", null, { before });
  return adminListRegistrars();
}

// deno-lint-ignore no-explicit-any
export async function adminGetTldPrices(p: any) {
  const tld = String(p?.tld ?? "").trim().toLowerCase().replace(/^\./, "");
  if (!TLD_RE.test(tld)) throw new BadRequest("Enter an extension like com or co.uk.");
  const db = serviceClient();
  const [{ data: regs }, { data: prices }] = await Promise.all([
    db.from("registrars").select("id, name, active").order("sort").order("name"),
    db.from("registrar_prices").select("*").eq("tld", tld),
  ]);
  const byReg = new Map((prices ?? []).map((r) => [r.registrar_id, r]));
  return {
    success: true,
    tld,
    rows: (regs ?? []).map((r) => {
      const price = byReg.get(r.id);
      return {
        registrarId: r.id,
        name: r.name,
        active: r.active,
        register: price ? Number(price.register) : null,
        renew: price ? Number(price.renew) : null,
        source: price?.source ?? null,
        updatedAt: price?.updated_at ?? null,
      };
    }),
  };
}

/** Prices for one extension. A row with both prices blank is removed. */
// deno-lint-ignore no-explicit-any
export async function adminSaveTldPrices(admin: Caller, p: any) {
  const tld = String(p?.tld ?? "").trim().toLowerCase().replace(/^\./, "");
  if (!TLD_RE.test(tld)) throw new BadRequest("Enter an extension like com or co.uk.");
  if (!Array.isArray(p?.rows) || p.rows.length > 100) throw new BadRequest("rows must be a list");

  const amount = (v: unknown, label: string) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n >= 100000) throw new BadRequest(`${label} must be a price in USD.`);
    return Math.round(n * 100) / 100;
  };
  const db = serviceClient();
  const { data: before } = await db.from("registrar_prices").select("*").eq("tld", tld);
  const upserts: Record<string, unknown>[] = [];
  const removals: string[] = [];
  for (const row of p.rows) {
    if (typeof row?.registrarId !== "string" || !/^[a-z0-9-]{2,40}$/.test(row.registrarId)) continue;
    const register = amount(row.register, `.${tld} first-year price`);
    const renew = amount(row.renew, `.${tld} renewal price`);
    if (register === null && renew === null) {
      removals.push(row.registrarId);
    } else {
      if (register === null || renew === null) throw new BadRequest("Enter both the first-year and the renewal price, or neither.");
      const old = (before ?? []).find((b) => b.registrar_id === row.registrarId);
      if (old && Number(old.register) === register && Number(old.renew) === renew) continue;   // unchanged
      upserts.push({ tld, registrar_id: row.registrarId, register, renew, source: "manual" });
    }
  }
  if (upserts.length) {
    const { error } = await db.from("registrar_prices").upsert(upserts, { onConflict: "tld,registrar_id" });
    if (error) throw new HttpError(400, error.message);
  }
  if (removals.length) await db.from("registrar_prices").delete().eq("tld", tld).in("registrar_id", removals);
  if (upserts.length || removals.length) {
    await audit(admin, "set_domain_prices", null, { tld, before, changed: upserts, removed: removals });
  }
  return adminGetTldPrices({ tld });
}

/** Reload Porkbun's prices now (the domain-search function does the work). */
export async function adminRefreshDomainPrices(admin: Caller) {
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/domain-search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    },
    body: JSON.stringify({ action: "refreshPrices" }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) throw new HttpError(502, body.message || "The price refresh failed.");
  await audit(admin, "refresh_domain_prices", null, { updated: body.updated });
  return { success: true, updated: body.updated };
}

// ---------------------------------------------------------------------------
// Customer emails: texts and brand (see _shared/email.ts)
// ---------------------------------------------------------------------------

function emailEntry(key: string, edited: Partial<Template> | undefined) {
  const def = TEMPLATES[key];
  return {
    key,
    name: def.name,
    when: def.when,
    vars: def.vars,
    hasButton: Boolean(def.buttonUrl),
    edited: Boolean(edited),
    template: effectiveTemplate(key, edited),
    defaults: { subject: def.subject, heading: def.heading, body: def.body, button: def.button },
  };
}

export async function adminListEmails() {
  const settings = await loadEmailSettings(true);
  return {
    success: true,
    brand: settings.brand,
    templates: Object.keys(TEMPLATES).map((k) => emailEntry(k, settings.templates.get(k))),
  };
}

// deno-lint-ignore no-explicit-any
function emailDraft(p: any): { key: string; template: Template } {
  const key = String(p?.key ?? "");
  if (!TEMPLATES[key]) throw new BadRequest("Unknown email.");
  const t = p?.template ?? {};
  const subject = String(t.subject ?? "").trim().slice(0, 200);
  if (!subject) throw new BadRequest("The subject cannot be empty.");
  return {
    key,
    template: {
      subject,
      heading: String(t.heading ?? "").trim().slice(0, 200),
      body: String(t.body ?? "").replace(/\r\n/g, "\n").slice(0, 5000),
      button: String(t.button ?? "").trim().slice(0, 60),
    },
  };
}

// deno-lint-ignore no-explicit-any
function brandDraft(p: any, current: Brand): Brand {
  const b = p?.brand;
  if (!b) return current;
  const brand = {
    logo_url: String(b.logo_url ?? "").trim(),
    accent_color: String(b.accent_color ?? "").trim(),
    footer_text: String(b.footer_text ?? "").trim().slice(0, 300),
  };
  if (brand.logo_url && !/^https:\/\/[^\s"<>]+$/.test(brand.logo_url)) throw new BadRequest("The logo must be an https:// image address.");
  if (!/^#[0-9a-fA-F]{6}$/.test(brand.accent_color)) throw new BadRequest("The colour must look like #ff5011.");
  return brand;
}

// deno-lint-ignore no-explicit-any
export async function adminSaveEmail(admin: Caller, p: any) {
  const { key, template } = emailDraft(p);
  const db = serviceClient();
  const { data: before } = await db.from("email_templates").select("*").eq("key", key).maybeSingle();
  const { error } = await db.from("email_templates").upsert({ key, ...template, updated_by: admin.email }, { onConflict: "key" });
  if (error) throw new HttpError(400, error.message);
  await audit(admin, "update_email_template", null, { key, before, after: template });
  return adminListEmails();
}

// deno-lint-ignore no-explicit-any
export async function adminResetEmail(admin: Caller, p: any) {
  const key = String(p?.key ?? "");
  if (!TEMPLATES[key]) throw new BadRequest("Unknown email.");
  const db = serviceClient();
  const { data: before } = await db.from("email_templates").select("*").eq("key", key).maybeSingle();
  await db.from("email_templates").delete().eq("key", key);
  if (before) await audit(admin, "reset_email_template", null, { key, before });
  return adminListEmails();
}

// deno-lint-ignore no-explicit-any
export async function adminSaveEmailBrand(admin: Caller, p: any) {
  const settings = await loadEmailSettings(true);
  const brand = brandDraft(p, settings.brand);
  const { error } = await serviceClient().from("email_settings").upsert({ id: true, ...brand }, { onConflict: "id" });
  if (error) throw new HttpError(400, error.message);
  await audit(admin, "update_email_brand", null, { before: settings.brand, after: brand });
  return adminListEmails();
}

/** The draft as it would look, with sample data. Nothing is saved. */
// deno-lint-ignore no-explicit-any
export async function adminPreviewEmail(p: any) {
  const { key, template } = emailDraft(p);
  const settings = await loadEmailSettings(true);
  const out = renderEmail(key, template, brandDraft(p, settings.brand), { ...TEMPLATES[key].sample, app_url: SITE_URL ? `${SITE_URL}/app/` : "#" });
  return { success: true, ...out };
}

/** Send the draft, with sample data, to the admin's own address. */
// deno-lint-ignore no-explicit-any
export async function adminSendTestEmail(admin: Caller, p: any) {
  const { subject, html } = await adminPreviewEmail(p);
  const sent = await sendEmail(admin.email, `[Test] ${subject}`, html);
  return sent
    ? { success: true, message: `Test sent to ${admin.email}.` }
    : { success: false, message: "The test email could not be sent (is email set up on the server?)." };
}
