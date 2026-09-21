// ============================================================================
// Domain Vault API
//
// A drop-in replacement for the Google Apps Script doPost router. The action
// names and response shapes are deliberately identical to the originals, so
// the existing frontend needs only a new URL and an Authorization header.
//
// What changed underneath:
//   * Identity comes from a verified JWT, not from an email in the request
//     body. This closes the hole that let anyone read any account.
//   * Passwords are handled by Supabase Auth (bcrypt). None are stored here.
//   * Registrar passwords are AES-256-GCM encrypted and are never returned to
//     the browser except through an explicit, rate-limited, audited reveal.
//   * Writes are atomic upserts instead of delete-everything-then-reinsert.
// ============================================================================

import { json, preflight } from "../_shared/cors.ts";
import {
  type Caller,
  clientIp,
  HttpError,
  rateLimit,
  requireAdmin,
  requireUser,
  serviceClient,
  userClient,
} from "../_shared/db.ts";
import { decryptSecret, encryptSecret, KEY_VERSION } from "../_shared/crypto.ts";
import { BadRequest, boundedArray, isUuid, isValidEmail, str } from "../_shared/validate.ts";
import { sendEmail, sendWhatsApp } from "../_shared/notify.ts";
import {
  adminAudit,
  adminGetPrices,
  adminListUsers,
  adminOverview,
  adminSales,
  adminSetPrice,
  adminUpdateUser,
} from "./admin.ts";

const ADMIN_EMAIL = Deno.env.get("ADMIN_EMAIL");
const ADMIN_PHONE = Deno.env.get("ADMIN_PHONE") ?? null;

const MAX_DOMAINS = 5000;
const MAX_PROVIDERS = 500;

// ---------------------------------------------------------------------------
// Row shaping — the database uses snake_case; the frontend expects the camel
// case keys the old sheet produced. Translation lives here so no frontend
// rendering code has to change.
// ---------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
function toClientDomain(row: any) {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider_name ?? "",
    purchaseDate: row.purchase_date ?? "",
    renewalDate: row.renewal_date ?? "",
    purchasePrice: Number(row.purchase_price ?? 0),
    renewalPrice: Number(row.renewal_price ?? 0),
    autoRenew: Boolean(row.auto_renew),
  };
}

// deno-lint-ignore no-explicit-any
function toClientProvider(row: any, hasPassword: boolean) {
  return {
    id: row.id,
    name: row.name,
    url: row.url ?? "",
    user: row.username ?? "",
    uid: row.uid ?? "",
    // The stored password is never sent with the rest of the data. The UI
    // shows a masked placeholder from hasPassword and calls revealCredential
    // only when the user explicitly asks to see it.
    pass: "",
    hasPassword,
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
async function registerUser(req: Request, p: any) {
  const email = isValidEmail(p?.email) ? p.email.trim().toLowerCase() : null;
  const password = typeof p?.password === "string" ? p.password : "";
  const phone = str(p?.phone, 32);
  const location = str(p?.location, 120);

  if (!email) return { success: false, message: "Please enter a valid email address." };
  if (password.length < 10) {
    return { success: false, message: "Password must be at least 10 characters." };
  }

  // Throttle by IP so the endpoint cannot be used to enumerate or spam.
  await rateLimit(`register:${clientIp(req)}`, 5, 3600);

  const admin = serviceClient();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    // Confirmed on creation so the account is usable. Leaving it unconfirmed
    // blocks sign-in permanently, since nothing in this flow ever sends a
    // confirmation link. The real gate is profiles.status, which an admin
    // flips to 'active' — the user can log in and is told they are pending.
    // Adding proper email verification is tracked in SECURITY.md.
    email_confirm: true,
    password,
    user_metadata: { phone, location },
  });

  if (error) {
    // Do not leak whether the address already exists.
    console.error("register failed", error.message);
    return {
      success: true,
      message: "Account created! Pending admin activation.",
    };
  }

  if (ADMIN_EMAIL) {
    await sendEmail(
      ADMIN_EMAIL,
      "New User Registration - Domain Vault",
      `<h3>New User Registration</h3>
       <p><b>Email:</b> ${escapeHtml(email)}</p>
       <p><b>Phone:</b> ${escapeHtml(phone ?? "-")}</p>
       <p><b>Location:</b> ${escapeHtml(location ?? "-")}</p>
       <p><b>User ID:</b> ${data.user?.id ?? "-"}</p>
       <p>Activate them in the admin panel, or set profiles.status = 'active'.</p>`,
    );
  }
  await sendWhatsApp(
    ADMIN_PHONE,
    `New Domain Vault registration: ${email} from ${location ?? "unknown"}.`,
  );
  await sendEmail(
    email,
    "Welcome to Domain Vault!",
    `<h3>Welcome to Domain Vault!</h3>
     <p>Your account has been created and is pending activation by our team.
     We'll email you as soon as it is live.</p>`,
  );
  await sendWhatsApp(phone, "Welcome to Domain Vault! Your account is pending activation.");

  return { success: true, message: "Account created! Pending admin activation." };
}

// deno-lint-ignore no-explicit-any
async function loginUser(req: Request, p: any) {
  const email = isValidEmail(p?.email) ? p.email.trim().toLowerCase() : null;
  const password = typeof p?.password === "string" ? p.password : "";
  if (!email || !password) return { success: false, message: "Email and password required." };

  // Bucket on both IP and address: slows credential stuffing without letting
  // one attacker lock a specific victim out by burning their bucket alone.
  await rateLimit(`login:${clientIp(req)}`, 20, 900);
  await rateLimit(`login:${email}`, 10, 900);

  const { data, error } = await userClient(req).auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    return { success: false, message: "Invalid email or password." };
  }

  const { data: profile } = await serviceClient()
    .from("profiles")
    .select("id, email, phone, plan, status, is_admin")
    .eq("id", data.user.id)
    .maybeSingle();

  if (!profile) return { success: false, message: "Profile missing. Contact support." };
  if (profile.status === "suspended") {
    return { success: false, message: "This account has been suspended." };
  }
  if (profile.status !== "active") {
    return { success: false, message: "Account pending activation by Admin." };
  }

  return {
    success: true,
    user: {
      id: profile.id,
      email: profile.email,
      phone: profile.phone ?? "",
      plan: profile.plan,
      isAdmin: profile.is_admin === true,
    },
    session: {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
    },
  };
}

async function getUserData(caller: Caller, db: ReturnType<typeof userClient>) {
  const [domains, providers, settings, secrets, purchases] = await Promise.all([
    db.from("domains").select("*").order("renewal_date", { nullsFirst: false }),
    db.from("providers").select("*").order("name"),
    db.from("settings").select("*").maybeSingle(),
    // Which providers have a stored password — ids only, never the ciphertext.
    serviceClient().from("provider_secrets").select("provider_id").eq("user_id", caller.id),
    db.from("purchases")
      .select("txn_id, plan, amount, currency, status, created_at")
      .order("created_at", { ascending: false }),
  ]);

  if (domains.error) throw new HttpError(500, domains.error.message);
  if (providers.error) throw new HttpError(500, providers.error.message);

  const withSecret = new Set((secrets.data ?? []).map((r) => r.provider_id));

  return {
    domains: (domains.data ?? []).map(toClientDomain),
    providers: (providers.data ?? []).map((r) => toClientProvider(r, withSecret.has(r.id))),
    settings: settings.data
      ? {
        theme: settings.data.theme,
        language: settings.data.language,
        username: settings.data.username,
        profilePicture: settings.data.profile_pic_url ?? "",
      }
      : null,
    // Always the server's current value: the plan changes after a purchase
    // or refund, and the session copy saved at login does not.
    plan: caller.plan,
    isAdmin: caller.is_admin === true,
    purchases: purchases.data ?? [],
  };
}

// deno-lint-ignore no-explicit-any
async function saveDomains(caller: Caller, db: ReturnType<typeof userClient>, p: any) {
  const incoming = boundedArray(p?.domains, MAX_DOMAINS);

  const { data, error } = await db.rpc("sync_domains", { p_domains: incoming });
  if (error) {
    if (/domain limit reached/i.test(error.message)) {
      throw new HttpError(
        402,
        `You have reached the domain limit for the ${caller.plan} plan. Upgrade to add more.`,
      );
    }
    if (error.code === "23505") {
      throw new HttpError(409, "You already have a domain with that name.");
    }
    throw new HttpError(400, error.message);
  }

  // deno-lint-ignore no-explicit-any
  return { success: true, domains: (data ?? []).map((r: any) => toClientDomain(r)) };
}

// deno-lint-ignore no-explicit-any
async function saveProviders(caller: Caller, db: ReturnType<typeof userClient>, p: any) {
  const incoming = boundedArray(p?.providers, MAX_PROVIDERS) as Record<string, unknown>[];

  // Non-secret fields go through the RLS-enforced RPC.
  const { data, error } = await db.rpc("sync_providers", { p_providers: incoming });
  if (error) {
    if (/still linked to domains/i.test(error.message)) {
      throw new HttpError(409, "Cannot delete a provider that still has domains.");
    }
    if (error.code === "23505") {
      throw new HttpError(409, "You already have a provider with that name.");
    }
    throw new HttpError(400, error.message);
  }

  // deno-lint-ignore no-explicit-any
  const saved = (data ?? []) as any[];
  const byName = new Map(saved.map((r) => [r.name.toLowerCase(), r.id]));
  const admin = serviceClient();

  // Secrets are written separately, with the service role, one row at a time.
  // An empty or absent password means "leave whatever is stored alone", so
  // that a normal save of a provider whose password the browser never saw
  // cannot silently erase it.
  for (const entry of incoming) {
    const name = typeof entry.name === "string" ? entry.name.trim().toLowerCase() : "";
    const providerId = isUuid(entry.id) ? entry.id as string : byName.get(name);
    if (!providerId) continue;

    if (entry.removePassword === true) {
      await admin.from("provider_secrets").delete()
        .eq("provider_id", providerId).eq("user_id", caller.id);
      continue;
    }

    const secret = typeof entry.pass === "string" ? entry.pass : "";
    if (!secret) continue;

    const { ciphertext, iv } = await encryptSecret(secret.slice(0, 512));
    const { error: secretError } = await admin.from("provider_secrets").upsert({
      provider_id: providerId,
      user_id: caller.id,
      ciphertext,
      iv,
      key_version: KEY_VERSION,
      set_at: new Date().toISOString(),
    }, { onConflict: "provider_id" });

    if (secretError) throw new HttpError(500, "Could not store the provider password.");
  }

  const { data: secrets } = await admin
    .from("provider_secrets").select("provider_id").eq("user_id", caller.id);
  const withSecret = new Set((secrets ?? []).map((r) => r.provider_id));

  return {
    success: true,
    providers: saved.map((r) => toClientProvider(r, withSecret.has(r.id))),
  };
}

// deno-lint-ignore no-explicit-any
async function revealCredential(req: Request, caller: Caller, p: any) {
  if (!isUuid(p?.providerId)) throw new BadRequest("providerId must be a uuid");

  // Deliberately tight: revealing stored passwords is the single most
  // sensitive operation in the product.
  await rateLimit(`reveal:${caller.id}`, 10, 3600);

  const admin = serviceClient();

  // Ownership is checked explicitly because this query uses the service role,
  // which bypasses RLS.
  const { data: row } = await admin
    .from("provider_secrets")
    .select("ciphertext, iv")
    .eq("provider_id", p.providerId)
    .eq("user_id", caller.id)
    .maybeSingle();

  await admin.from("credential_access_log").insert({
    user_id: caller.id,
    provider_id: p.providerId,
    action: row ? "reveal" : "reveal_miss",
    ip: clientIp(req),
    user_agent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
  });

  if (!row) return { success: false, message: "No stored password for that provider." };

  return { success: true, password: await decryptSecret(row.ciphertext, row.iv) };
}

// deno-lint-ignore no-explicit-any
async function saveSettings(caller: Caller, db: ReturnType<typeof userClient>, p: any) {
  const s = p?.settings ?? {};
  let pictureUrl = str(s.profilePicture, 2000);

  // The old backend pasted a base64 data URL into a spreadsheet cell. Anything
  // arriving that way is moved into Storage and replaced with its URL.
  if (typeof s.profilePicture === "string" && s.profilePicture.startsWith("data:")) {
    pictureUrl = await uploadAvatar(caller.id, s.profilePicture);
  }

  const row = {
    user_id: caller.id,
    theme: str(s.theme, 32) ?? "dark",
    language: str(s.language, 8) ?? "en",
    username: str(s.username, 80),
    ...(pictureUrl ? { profile_pic_url: pictureUrl } : {}),
  };

  const { error } = await db.from("settings").upsert(row, { onConflict: "user_id" });
  if (error) throw new HttpError(400, error.message);

  return { success: true, profilePicture: pictureUrl ?? "" };
}

async function uploadAvatar(userId: string, dataUrl: string): Promise<string | null> {
  const match = /^data:(image\/(png|jpe?g|webp|gif));base64,(.+)$/i.exec(dataUrl);
  if (!match) throw new BadRequest("Profile picture must be a PNG, JPEG, WebP or GIF image.");

  const bytes = Uint8Array.from(atob(match[3]), (c) => c.charCodeAt(0));
  if (bytes.byteLength > 2 * 1024 * 1024) {
    throw new BadRequest("Profile picture must be under 2 MB.");
  }

  const ext = match[1].split("/")[1].replace("jpeg", "jpg");
  const path = `${userId}/avatar.${ext}`;
  const admin = serviceClient();

  const { error } = await admin.storage.from("avatars").upload(path, bytes, {
    contentType: match[1],
    upsert: true,
  });
  if (error) {
    console.error("avatar upload failed", error.message);
    return null;
  }

  return admin.storage.from("avatars").getPublicUrl(path).data.publicUrl;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Public: pack prices for the upgrade modal. Unpriced packs are listed as null. */
async function getPrices() {
  const { data, error } = await serviceClient()
    .from("plan_prices").select("plan, amount, currency");
  if (error) throw new HttpError(500, error.message);
  return { success: true, prices: data ?? [] };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const PUBLIC_ACTIONS = new Set(["registerUser", "loginUser", "getPrices"]);
const ADMIN_ACTIONS = new Set([
  "adminOverview", "adminListUsers", "adminUpdateUser",
  "adminSales", "adminGetPrices", "adminSetPrice", "adminAudit",
]);

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== "POST") return json(req, { success: false, error: "POST only" }, 405);

  try {
    const body = await req.json().catch(() => {
      throw new BadRequest("Body must be JSON.");
    });
    const action = typeof body?.action === "string" ? body.action : "";

    if (PUBLIC_ACTIONS.has(action)) {
      if (action === "registerUser") return json(req, await registerUser(req, body));
      if (action === "loginUser") return json(req, await loginUser(req, body));
      await rateLimit(`prices:${clientIp(req)}`, 60, 60);
      return json(req, await getPrices());
    }

    if (ADMIN_ACTIONS.has(action)) {
      const { caller } = await requireAdmin(req);
      await rateLimit(`admin:${caller.id}`, 120, 60);
      switch (action) {
        case "adminOverview":
          return json(req, await adminOverview());
        case "adminListUsers":
          return json(req, await adminListUsers(body));
        case "adminUpdateUser":
          return json(req, await adminUpdateUser(caller, body));
        case "adminSales":
          return json(req, await adminSales(body));
        case "adminGetPrices":
          return json(req, await adminGetPrices());
        case "adminSetPrice":
          return json(req, await adminSetPrice(caller, body));
        case "adminAudit":
          return json(req, await adminAudit(body));
      }
    }

    const { caller, db } = await requireUser(req);
    await rateLimit(`api:${caller.id}`, 300, 60);

    switch (action) {
      case "getUserData":
        return json(req, await getUserData(caller, db));
      case "saveDomains":
        return json(req, await saveDomains(caller, db, body));
      case "saveProviders":
        return json(req, await saveProviders(caller, db, body));
      case "saveSettings":
        return json(req, await saveSettings(caller, db, body));
      case "revealCredential":
        return json(req, await revealCredential(req, caller, body));
      default:
        return json(req, { success: false, message: "Unknown API action" }, 400);
    }
  } catch (err) {
    if (err instanceof HttpError) {
      return json(req, { success: false, message: err.message, error: err.message }, err.status);
    }
    if (err instanceof BadRequest) {
      return json(req, { success: false, message: err.message, error: err.message }, 400);
    }
    console.error("unhandled", err);
    return json(req, { success: false, message: "Server error.", error: "Server error." }, 500);
  }
});
