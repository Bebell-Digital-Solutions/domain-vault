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
import { sendEmail } from "../_shared/notify.ts";

const PLANS = ["Personal", "Start-up", "Business", "Agency"] as const;
const PAID_PLANS = ["Start-up", "Business", "Agency"] as const;
const STATUSES = ["pending", "active", "suspended"] as const;
const PURCHASE_STATUSES = [
  "completed", "pending", "refunded", "reversed", "rejected", "unmatched", "failed",
] as const;

const SITE_URL = Deno.env.get("SITE_URL") ?? "";

async function audit(
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

  const [profiles, domains, purchases] = await Promise.all([
    db.from("profiles").select("status, plan"),
    db.from("domains").select("id", { count: "exact", head: true }),
    db.from("purchases").select("status, amount, currency"),
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

  return {
    success: true,
    total: count ?? 0,
    users: (data ?? []).map((u) => ({ ...u, domain_count: counts.get(u.id) ?? 0 })),
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
    await sendEmail(
      before.email,
      "Your Domain Vault account is active",
      `<h3>You're in!</h3>
       <p>Your Domain Vault account has been activated. You can log in now.</p>
       ${SITE_URL ? `<p><a href="${SITE_URL}">Open Domain Vault</a></p>` : ""}`,
    );
  }

  return { success: true, user: after };
}

// deno-lint-ignore no-explicit-any
export async function adminSales(p: any) {
  const db = serviceClient();
  let query = db
    .from("purchases")
    .select("id, txn_id, email, payer_email, plan, amount, currency, status, reason, source, created_at, updated_at")
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

export async function adminGetPrices() {
  const { data, error } = await serviceClient()
    .from("plan_prices").select("plan, amount, currency, updated_at").order("plan");
  if (error) throw new HttpError(500, error.message);
  return { success: true, prices: data ?? [] };
}

// deno-lint-ignore no-explicit-any
export async function adminSetPrice(admin: Caller, p: any) {
  if (!PAID_PLANS.includes(p?.plan)) throw new BadRequest("plan must be Start-up, Business or Agency");

  const amount = p.amount === null || p.amount === "" ? null : Number(p.amount);
  if (amount !== null && (!Number.isFinite(amount) || amount <= 0 || amount > 100000)) {
    throw new BadRequest("amount must be a positive number, or empty to take the pack off sale");
  }
  const currency = typeof p.currency === "string" ? p.currency.trim().toUpperCase() : "USD";
  if (!/^[A-Z]{3}$/.test(currency)) throw new BadRequest("currency must be a 3-letter code, e.g. USD");

  const db = serviceClient();
  const { data: before } = await db
    .from("plan_prices").select("amount, currency").eq("plan", p.plan).maybeSingle();

  const rounded = amount === null ? null : Math.round(amount * 100) / 100;
  const { error } = await db.from("plan_prices")
    .upsert({ plan: p.plan, amount: rounded, currency }, { onConflict: "plan" });
  if (error) throw new HttpError(500, error.message);

  await audit(admin, "set_price", null, {
    plan: p.plan,
    before,
    after: { amount: rounded, currency },
  });

  return adminGetPrices();
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
