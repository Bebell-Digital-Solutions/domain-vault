import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/**
 * Client bound to the caller's JWT. Every query through this client is
 * subject to RLS, so it physically cannot read another user's rows. This is
 * the default for anything touching user data.
 */
export function userClient(req: Request): SupabaseClient {
  const authorization = req.headers.get("Authorization") ?? "";
  return createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Full-privilege client that bypasses RLS. Reserved for the few operations a
 * user legitimately cannot perform on their own behalf: reading
 * provider_secrets, writing the audit log, the billing webhook, and the
 * nightly reminder sweep. Never hand this client a user-supplied filter
 * without checking ownership first.
 */
export function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface Caller {
  id: string;
  email: string;
  plan: string;
  status: string;
  phone: string | null;
  is_admin: boolean;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Resolve the caller from their JWT and load their profile.
 *
 * This is the replacement for the old backend's "trust the email in the
 * request body". The identity comes from a signature Supabase Auth verified;
 * the client has no say in it.
 */
export async function requireUser(req: Request): Promise<{ caller: Caller; db: SupabaseClient }> {
  const db = userClient(req);
  const { data: auth, error } = await db.auth.getUser();
  if (error || !auth?.user) throw new HttpError(401, "Not signed in.");

  const { data: profile } = await serviceClient()
    .from("profiles")
    .select("id, email, plan, status, phone, is_admin")
    .eq("id", auth.user.id)
    .maybeSingle();

  if (!profile) throw new HttpError(403, "Profile missing. Contact support.");
  if (profile.status === "suspended") throw new HttpError(403, "This account has been suspended.");
  if (profile.status !== "active") {
    throw new HttpError(403, "Account pending activation by Admin.");
  }

  return { caller: profile as Caller, db };
}

/** requireUser, plus the caller must hold the admin flag. */
export async function requireAdmin(req: Request): Promise<{ caller: Caller; db: SupabaseClient }> {
  const result = await requireUser(req);
  if (!result.caller.is_admin) throw new HttpError(403, "Administrators only.");
  return result;
}

/**
 * Fixed-window rate limit. Throws 429 when the budget is spent.
 * The counter is incremented atomically in SQL — see consume_rate_limit.
 */
export async function rateLimit(
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const { data, error } = await serviceClient().rpc("consume_rate_limit", {
    p_bucket: bucket,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });

  // Fail open on infrastructure errors rather than locking every user out of
  // the product because the counter table is unhappy.
  if (error) {
    console.error("rate limit check failed", error.message);
    return;
  }
  if (data === false) throw new HttpError(429, "Too many requests. Please slow down.");
}

/** Best-effort client IP, for rate-limit buckets and the audit log. */
export function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    req.headers.get("cf-connecting-ip") ??
    "unknown"
  );
}
