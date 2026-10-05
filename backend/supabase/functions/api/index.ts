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

import { isAllowedOrigin, json, preflight } from "../_shared/cors.ts";
import {
  anonClient,
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
const SITE_URL = (Deno.env.get("SITE_URL") ?? "").replace(/\/+$/, "");

const MIN_PASSWORD_LENGTH = 10;

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
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { success: false, message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
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

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/**
 * Where the reset link lands: the page that asked for it, if the site is
 * served from that origin, otherwise the app on the main site. Auth checks
 * the target against its own redirect allow-list as well.
 */
function resetRedirect(requested: unknown): string | undefined {
  if (typeof requested === "string") {
    try {
      const url = new URL(requested);
      if (isAllowedOrigin(url.origin)) return url.origin + url.pathname;
    } catch { /* fall through */ }
  }
  return SITE_URL ? `${SITE_URL}/app/` : undefined;
}

/** Public: email a password-reset link. The answer never says whether the address has an account. */
// deno-lint-ignore no-explicit-any
async function requestPasswordReset(req: Request, p: any) {
  const email = isValidEmail(p?.email) ? p.email.trim().toLowerCase() : null;
  if (!email) return { success: false, message: "Please enter a valid email address." };

  await rateLimit(`reset:${clientIp(req)}`, 5, 3600);
  await rateLimit(`reset:${email}`, 3, 3600);

  const { error } = await anonClient().auth.resetPasswordForEmail(email, {
    redirectTo: resetRedirect(p?.redirectTo),
  });
  if (error) console.error("password reset email failed", error.message);

  return {
    success: true,
    message: "If that address has an account, a reset link is on its way. Check your inbox.",
  };
}

/** Change the password of the signed-in user, who must prove they know the current one. */
// deno-lint-ignore no-explicit-any
async function changePassword(caller: Caller, p: any) {
  const current = typeof p?.currentPassword === "string" ? p.currentPassword : "";
  const next = typeof p?.newPassword === "string" ? p.newPassword : "";

  if (!current) return { success: false, message: "Enter your current password." };
  if (next.length < MIN_PASSWORD_LENGTH) {
    return { success: false, message: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (next === current) {
    return { success: false, message: "The new password must differ from the current one." };
  }

  // Same budget as a login: this endpoint can also be used to test passwords.
  await rateLimit(`password:${caller.id}`, 5, 900);

  // Proving the current password opens a fresh session, and the change is
  // made through it. Auth then ends every other session (other devices, and
  // this tab's old one) and keeps this one, which goes back to the browser.
  // The admin API would end them all; a change through the caller's own
  // session can require re-authentication if the project's "secure password
  // change" setting is on. A session minutes old satisfies both.
  const verifier = anonClient();
  const { data: check, error: checkError } = await verifier.auth.signInWithPassword({
    email: caller.email,
    password: current,
  });
  if (checkError || !check.session) {
    return { success: false, message: "Your current password is incorrect." };
  }

  const { error } = await verifier.auth.updateUser({ password: next });
  if (error) {
    // Auth's own policy (length, leaked-password check) is worded for users.
    return { success: false, message: error.message || "Could not change the password." };
  }

  return {
    success: true,
    message: "Password changed. Your other devices have been signed out.",
    session: {
      access_token: check.session.access_token,
      refresh_token: check.session.refresh_token,
      expires_at: check.session.expires_at,
    },
  };
}

// ---------------------------------------------------------------------------
// Calendar subscription feed (served by the calendar function)
// ---------------------------------------------------------------------------

/** 32 random bytes, base64url: 43 characters, matching calendar_feeds_token_shape. */
function newFeedToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The caller's feed token, created on first use. The browser builds the URL. */
async function getCalendarFeed(caller: Caller) {
  const admin = serviceClient();
  // Insert-if-absent, then read: two tabs asking at once still agree.
  await admin.from("calendar_feeds").upsert(
    { user_id: caller.id, token: newFeedToken() },
    { onConflict: "user_id", ignoreDuplicates: true },
  );
  const { data, error } = await admin
    .from("calendar_feeds").select("token").eq("user_id", caller.id).single();
  if (error || !data) throw new HttpError(500, "Could not create the calendar link.");
  return { success: true, token: data.token };
}

/** Replace the token. Calendars subscribed to the old link stop updating. */
async function resetCalendarFeed(caller: Caller) {
  const token = newFeedToken();
  const { error } = await serviceClient().from("calendar_feeds").upsert(
    { user_id: caller.id, token, created_at: new Date().toISOString() },
    { onConflict: "user_id" },
  );
  if (error) throw new HttpError(500, "Could not reset the calendar link.");
  return { success: true, token };
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
        reminders: {
          enabled: settings.data.reminders_enabled !== false,
          channels: settings.data.reminder_channels ?? ["email"],
          leadDays: settings.data.reminder_lead_days ?? [30, 7, 1, 0],
        },
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

  const row: Record<string, unknown> = {
    user_id: caller.id,
    theme: str(s.theme, 32) ?? "dark",
    language: str(s.language, 8) ?? "en",
    username: str(s.username, 80),
    // An empty picture removes it; leaving the key out keeps the stored one.
    ...(pictureUrl
      ? { profile_pic_url: pictureUrl }
      : (typeof s === "object" && s !== null && "profilePicture" in s ? { profile_pic_url: null } : {})),
  };

  // Reminder preferences are optional: a client that does not send them
  // leaves the stored values alone.
  const prefs = s.reminders;
  if (prefs && typeof prefs === "object") {
    if (prefs.enabled !== undefined) row.reminders_enabled = prefs.enabled !== false;

    if (Array.isArray(prefs.channels)) {
      const channels = [...new Set(prefs.channels)].filter((c) => c === "email" || c === "whatsapp");
      if (channels.length === 0) {
        throw new BadRequest("Choose at least one way to be reminded, or switch reminders off.");
      }
      row.reminder_channels = channels;
    }

    if (Array.isArray(prefs.leadDays)) {
      // Must match settings_lead_days_valid in the database.
      const allowed = [0, 1, 3, 7, 14, 30, 60, 90];
      const days = [...new Set(prefs.leadDays.map(Number))]
        .filter((d) => allowed.includes(d))
        .sort((a, b) => b - a);
      if (days.length === 0) throw new BadRequest("Choose at least one reminder time.");
      if (days.length > 6) throw new BadRequest("Choose at most six reminder times.");
      row.reminder_lead_days = days;
    }
  }

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

  // Same path on every upload; the version makes browsers fetch the new one.
  return `${admin.storage.from("avatars").getPublicUrl(path).data.publicUrl}?v=${Date.now()}`;
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

const PUBLIC_ACTIONS = new Set(["registerUser", "loginUser", "getPrices", "requestPasswordReset"]);
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
      if (action === "requestPasswordReset") return json(req, await requestPasswordReset(req, body));
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
      case "changePassword":
        return json(req, await changePassword(caller, body));
      case "getCalendarFeed":
        return json(req, await getCalendarFeed(caller));
      case "resetCalendarFeed":
        return json(req, await resetCalendarFeed(caller));
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
