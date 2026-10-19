// ============================================================================
// License codes — how marketplace buyers (AppSumo, SaaSZilla, …) get in
//
// The admin creates a batch of codes for a marketplace and uploads the CSV
// there. A buyer redeems their code when signing up, logging in, or in
// Settings → License keys. Codes stack: 1 Personal … 4 Agency, lifetime
// (see 20261020000100_license_codes.sql). Only a hash of each code is kept.
// ============================================================================

import { type Caller, clientIp, HttpError, rateLimit, serviceClient } from "../_shared/db.ts";
import { BadRequest, str } from "../_shared/validate.ts";
import { audit } from "./admin.ts";

export const MAX_CODES = 4;

// Crockford base32: no I, L, O or U, so a code read aloud or retyped survives.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PREFIXES: Record<string, string> = { appsumo: "DVAS", saaszilla: "DVSZ" };

/** What we compare: letters and digits only, upper case. Dashes and spaces are cosmetic. */
export function normalizeCode(code: unknown): string | null {
  if (typeof code !== "string") return null;
  const n = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return n.length >= 8 && n.length <= 64 ? n : null;
}

export async function hashCode(normalized: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newCode(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));   // 16 × 5 bits = 80 bits
  const chars = [...bytes].map((b) => ALPHABET[b & 31]).join("");
  return `${prefix}-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}`;
}

function redeemMessage(error: { code?: string; message: string }) {
  if (error.code === "P0001") return "This code is already on your account.";
  if (error.code === "P0003") return "Your account already has 4 codes: that's the Agency plan, the highest.";
  if (/revoked/.test(error.message)) return "This code is no longer valid (it was refunded).";
  if (/already used/.test(error.message)) return "This code has already been redeemed on another account.";
  if (error.code === "P0002") return "This code is not valid. Check it and try again.";
  return "Could not redeem the code. Contact support.";
}

/** Redeem a code for a user; returns the plan afterwards or a user-facing message. */
export async function redeemCode(req: Request, code: unknown, userId: string) {
  const normalized = normalizeCode(code);
  if (!normalized) return { ok: false as const, message: "Enter your license code." };
  // Guessing is hopeless (80 random bits), and this keeps it that way.
  await rateLimit(`license:${clientIp(req)}`, 10, 3600);
  await rateLimit(`license-user:${userId}`, 10, 3600);
  const { data, error } = await serviceClient().rpc("redeem_license_code", {
    p_code_hash: await hashCode(normalized),
    p_user: userId,
  });
  if (error) return { ok: false as const, message: redeemMessage(error) };
  const row = Array.isArray(data) ? data[0] : data;
  return { ok: true as const, plan: row?.plan as string, codes: Number(row?.codes ?? 0) };
}

/** The caller's redeemed codes (masked), for Settings → License keys. */
export async function getLicenseCodes(caller: Caller) {
  const db = serviceClient();
  const { data, error } = await db.from("license_codes")
    .select("hint, redeemed_at, status, license_batches(marketplace)")
    .eq("redeemed_by", caller.id).in("status", ["redeemed", "revoked"]).order("redeemed_at");
  if (error) throw new HttpError(500, error.message);
  const codes = (data ?? []).map((c) => ({
    hint: c.hint,
    // deno-lint-ignore no-explicit-any
    marketplace: (c as any).license_batches?.marketplace ?? "",
    redeemedAt: c.redeemed_at,
    active: c.status === "redeemed",
  }));
  return { success: true, codes, active: codes.filter((c) => c.active).length, max: MAX_CODES, plan: caller.plan };
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export async function adminListLicenseBatches() {
  const db = serviceClient();
  const [{ data: batches, error }, { data: counts }] = await Promise.all([
    db.from("license_batches").select("*").order("created_at", { ascending: false }),
    db.rpc("license_batch_counts"),
  ]);
  if (error) throw new HttpError(500, error.message);
  // deno-lint-ignore no-explicit-any
  const byBatch = new Map<string, any>();
  // deno-lint-ignore no-explicit-any
  for (const c of (counts ?? []) as any[]) {
    const e = byBatch.get(c.batch_id) ?? { available: 0, redeemed: 0, revoked: 0 };
    e[c.status] = Number(c.n);
    byBatch.set(c.batch_id, e);
  }
  return {
    success: true,
    batches: (batches ?? []).map((b) => ({ ...b, counts: byBatch.get(b.id) ?? { available: 0, redeemed: 0, revoked: 0 } })),
  };
}

/** A new batch; the plain codes are returned this once, for the marketplace's CSV. */
// deno-lint-ignore no-explicit-any
export async function adminCreateLicenseBatch(admin: Caller, p: any) {
  const marketplace = String(p?.marketplace ?? "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!/^[a-z0-9-]{2,30}$/.test(marketplace)) throw new BadRequest("Choose the marketplace, e.g. appsumo.");
  const size = Math.round(Number(p?.size));
  if (!Number.isFinite(size) || size < 1 || size > 10000) throw new BadRequest("A batch has 1 to 10,000 codes (AppSumo asks for 1,000 to 10,000).");
  const label = str(p?.label, 100) ?? "";
  const prefix = PREFIXES[marketplace] ?? `DV${marketplace.replace(/-/g, "").slice(0, 2).toUpperCase()}`;

  const db = serviceClient();
  const { data: batch, error } = await db.from("license_batches")
    .insert({ marketplace, size, label, created_by: admin.email }).select().single();
  if (error) throw new HttpError(400, error.message);

  const codes = new Set<string>();
  while (codes.size < size) codes.add(newCode(prefix));
  const list = [...codes];
  const rows = await Promise.all(list.map(async (c) => {
    const n = normalizeCode(c)!;
    return { code_hash: await hashCode(n), batch_id: batch.id, hint: n.slice(-4) };
  }));
  for (let i = 0; i < rows.length; i += 1000) {
    const { error: e } = await db.from("license_codes").insert(rows.slice(i, i + 1000));
    if (e) {
      await db.from("license_batches").delete().eq("id", batch.id);   // codes cascade
      throw new HttpError(500, `The batch could not be saved: ${e.message}`);
    }
  }
  await audit(admin, "create_license_batch", null, { batch: batch.id, marketplace, size, label });
  return { success: true, batch, codes: list };
}

async function findCode(code: unknown) {
  const normalized = normalizeCode(code);
  if (!normalized) throw new BadRequest("Enter a code.");
  const db = serviceClient();
  const { data } = await db.from("license_codes")
    .select("code_hash, hint, status, redeemed_by, redeemed_at, revoked_at, revoke_reason, license_batches(marketplace, label, created_at)")
    .eq("code_hash", await hashCode(normalized)).maybeSingle();
  if (!data) throw new HttpError(404, "No such code in any batch.");
  return data;
}

async function describe(code: Awaited<ReturnType<typeof findCode>>) {
  let email: string | null = null;
  if (code.redeemed_by) {
    const { data } = await serviceClient().from("profiles").select("email, plan").eq("id", code.redeemed_by).maybeSingle();
    email = data ? `${data.email} (now ${data.plan})` : null;
  }
  return {
    success: true,
    code: {
      hint: code.hint,
      status: code.status,
      // deno-lint-ignore no-explicit-any
      batch: (code as any).license_batches,
      redeemedBy: email,
      redeemedAt: code.redeemed_at,
      revokedAt: code.revoked_at,
      revokeReason: code.revoke_reason,
    },
  };
}

// deno-lint-ignore no-explicit-any
export async function adminFindLicenseCode(p: any) {
  return describe(await findCode(p?.code));
}

/** Revoke (e.g. refunded on the marketplace) or reinstate a code. */
// deno-lint-ignore no-explicit-any
export async function adminSetLicenseCode(admin: Caller, p: any) {
  const code = await findCode(p?.code);
  const revoke = p?.revoke === true;
  const { error } = await serviceClient().rpc("set_license_code_status", {
    p_code_hash: code.code_hash,
    p_revoke: revoke,
    p_reason: str(p?.reason, 200) ?? (revoke ? "refunded" : ""),
  });
  if (error) throw new HttpError(400, error.message);
  await audit(admin, revoke ? "revoke_license_code" : "reinstate_license_code", null, { hint: code.hint, before: code.status });
  return describe(await findCode(p?.code));
}

/** A leaked or withdrawn batch: every code not yet redeemed stops working. */
// deno-lint-ignore no-explicit-any
export async function adminRevokeUnusedCodes(admin: Caller, p: any) {
  const id = String(p?.batchId ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BadRequest("batchId is required");
  const { data, error } = await serviceClient().from("license_codes")
    .update({ status: "revoked", revoked_at: new Date().toISOString(), revoke_reason: "batch withdrawn" })
    .eq("batch_id", id).eq("status", "available").select("hint");
  if (error) throw new HttpError(500, error.message);
  await audit(admin, "revoke_unused_license_codes", null, { batch: id, count: data?.length ?? 0 });
  return adminListLicenseBatches();
}
