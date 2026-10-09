// ============================================================================
// Team vaults
//
// A vault is one account's domains and providers. The owner can invite
// people into it and choose what each of them may do (team_members). The
// database decides who may touch which row — member_can and the row level
// security on domains and providers, see 20261009000100_teams.sql — so this
// module only has to:
//
//   * work out which vault a request is about (the caller's own by default),
//   * write one item at a time: two people editing the same vault must not
//     overwrite each other, which saving the whole list would do,
//   * run the team screen: invitations, permissions, removal, activity.
//
// Queries that touch user rows go through the caller's client (RLS applies).
// The service client is used only after resolveVault has checked access, for
// what RLS cannot express: secrets, the team tables and the activity log.
// ============================================================================

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { type Caller, clientIp, HttpError, rateLimit, serviceClient } from "../_shared/db.ts";
import { decryptSecret, encryptSecret, KEY_VERSION } from "../_shared/crypto.ts";
import { BadRequest, isUuid, isValidEmail, str } from "../_shared/validate.ts";
import { sendEmail } from "../_shared/notify.ts";

const SITE_URL = (Deno.env.get("SITE_URL") ?? "").replace(/\/+$/, "");

// ---------------------------------------------------------------------------
// Permissions — as the app names them, and the column that holds each.
// ---------------------------------------------------------------------------

const PERM_COLUMNS = {
  editDomains: "can_edit_domains",
  editProviders: "can_edit_providers",
  delete: "can_delete",
  export: "can_export",
  passwords: "can_see_passwords",
  manage: "can_manage_team",
  reminders: "gets_reminders",
} as const;

export type Perm = keyof typeof PERM_COLUMNS;
export type Permissions = Record<Perm, boolean>;
const PERMS = Object.keys(PERM_COLUMNS) as Perm[];

/** For the invitation email. Viewing is always included. */
const PERM_LABELS: Record<Perm, string> = {
  editDomains: "add and edit domains",
  editProviders: "add and edit providers",
  delete: "delete domains and providers",
  export: "export the data",
  passwords: "see stored passwords",
  manage: "manage the team",
  reminders: "receive renewal reminders",
};

const OWNER_PERMS: Permissions = Object.fromEntries(PERMS.map((k) => [k, true])) as Permissions;

// deno-lint-ignore no-explicit-any
function permsFromRow(row: any): Permissions {
  return Object.fromEntries(PERMS.map((k) => [k, row?.[PERM_COLUMNS[k]] === true])) as Permissions;
}

function permsFromInput(value: unknown): Permissions {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return Object.fromEntries(PERMS.map((k) => [k, input[k] === true])) as Permissions;
}

function permColumns(perms: Permissions): Record<string, boolean> {
  return Object.fromEntries(PERMS.map((k) => [PERM_COLUMNS[k], perms[k]]));
}

// ---------------------------------------------------------------------------
// Row shaping — the database uses snake_case; the app expects the camel case
// keys the old sheet produced.
// ---------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
export function toClientDomain(row: any) {
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
export function toClientProvider(row: any, hasPassword: boolean) {
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
// Which vault
// ---------------------------------------------------------------------------

export interface Vault {
  ownerId: string;
  ownerEmail: string;
  plan: string;
  isOwner: boolean;
  can: Permissions;
}

/**
 * The vault a request is about: the caller's own (no vaultId), or one they
 * are a member of and still have access to — the owner's plan may have
 * fewer seats now, or either account may be suspended.
 */
export async function resolveVault(caller: Caller, vaultId: unknown): Promise<Vault> {
  if (vaultId === undefined || vaultId === null || vaultId === "" || vaultId === caller.id) {
    return { ownerId: caller.id, ownerEmail: caller.email, plan: caller.plan, isOwner: true, can: OWNER_PERMS };
  }
  if (!isUuid(vaultId)) throw new BadRequest("vaultId must be a uuid");

  const admin = serviceClient();
  const [access, membership, owner] = await Promise.all([
    admin.rpc("member_can", { p_owner: vaultId, p_member: caller.id, p_perm: "view" }),
    admin.from("team_members").select("*").eq("owner_id", vaultId).eq("member_id", caller.id).maybeSingle(),
    admin.from("profiles").select("email, plan").eq("id", vaultId).maybeSingle(),
  ]);
  if (access.error) throw new HttpError(500, access.error.message);
  if (access.data !== true || !membership.data || !owner.data) {
    throw new HttpError(403, "You no longer have access to that vault.");
  }
  return {
    ownerId: vaultId,
    ownerEmail: owner.data.email,
    plan: owner.data.plan,
    isOwner: false,
    can: permsFromRow(membership.data),
  };
}

/** What the app needs to know about the vault it is showing. */
export function vaultInfo(vault: Vault) {
  return {
    id: vault.ownerId,
    ownerEmail: vault.ownerEmail,
    plan: vault.plan,
    isOwner: vault.isOwner,
    permissions: vault.can,
  };
}

/** Every vault the caller can open: their own first, then their teams. */
export async function listVaults(caller: Caller) {
  const own = {
    id: caller.id,
    ownerEmail: caller.email,
    ownerName: null as string | null,
    plan: caller.plan,
    isOwner: true,
    active: true,
    permissions: OWNER_PERMS,
  };
  const admin = serviceClient();
  const { data: rows } = await admin.from("team_members").select("*")
    .eq("member_id", caller.id).order("created_at");
  if (!rows?.length) return [own];

  const ownerIds = rows.map((r) => r.owner_id as string);
  const [owners, names, access] = await Promise.all([
    admin.from("profiles").select("id, email, plan").in("id", ownerIds),
    admin.from("settings").select("user_id, username").in("user_id", ownerIds),
    Promise.all(ownerIds.map((id) =>
      admin.rpc("member_can", { p_owner: id, p_member: caller.id, p_perm: "view" })
    )),
  ]);
  const ownerById = new Map((owners.data ?? []).map((o) => [o.id, o]));
  const nameById = new Map((names.data ?? []).map((s) => [s.user_id, s.username as string | null]));

  return [
    own,
    ...rows.map((r, i) => ({
      id: r.owner_id as string,
      ownerEmail: ownerById.get(r.owner_id)?.email ?? "",
      ownerName: nameById.get(r.owner_id) ?? null,
      plan: ownerById.get(r.owner_id)?.plan ?? "",
      isOwner: false,
      // False while the owner's plan has too few seats for this member, or
      // the owner's account is suspended. Shown, but cannot be opened.
      active: access[i].data === true,
      permissions: permsFromRow(r),
    })),
  ];
}

function requirePerm(vault: Vault, perm: Perm, what: string) {
  if (!vault.can[perm]) throw new HttpError(403, `You do not have permission to ${what} in this vault.`);
}

// ---------------------------------------------------------------------------
// Activity log. Members' changes to the vault and every team change are
// recorded for the owner and team managers. The owner's own edits to their
// vault are not: they are the owner's data.
// ---------------------------------------------------------------------------

async function logActivity(
  ownerId: string,
  actor: { id: string; email: string },
  action: string,
  target: string | null,
  details: Record<string, unknown> = {},
) {
  const { error } = await serviceClient().from("vault_activity").insert({
    owner_id: ownerId,
    actor_id: actor.id,
    actor_email: actor.email,
    action,
    target,
    details,
  });
  if (error) console.error("vault activity not recorded", error.message);
}

// ---------------------------------------------------------------------------
// Writing one item at a time
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateOrNull(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  // The app may hold an ISO timestamp from an old import; the day is what counts.
  const day = typeof value === "string" ? value.slice(0, 10) : "";
  if (!DATE_RE.test(day) || Number.isNaN(Date.parse(day))) {
    throw new BadRequest(`${label} must be a date (YYYY-MM-DD).`);
  }
  return day;
}

function amount(value: unknown, label: string): number {
  if (value === undefined || value === null || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n >= 1e10) throw new BadRequest(`${label} must be zero or more.`);
  return Math.round(n * 100) / 100;
}

function writeError(error: { code?: string; message: string }, vault: Vault, kind: "domain" | "provider") {
  if (/domain limit reached/i.test(error.message)) {
    return new HttpError(
      402,
      vault.isOwner
        ? `You have reached the domain limit for the ${vault.plan} plan. Upgrade to add more.`
        : `This vault has reached the domain limit of its ${vault.plan} plan. Ask the owner to upgrade.`,
    );
  }
  if (error.code === "23505") {
    return /name_uniq/.test(error.message)
      ? new HttpError(409, vault.isOwner
        ? `You already have a ${kind} with that name.`
        : `This vault already has a ${kind} with that name.`)
      : new HttpError(409, "That item was changed elsewhere. Reload and try again.");
  }
  if (error.code === "42501") return new HttpError(403, "You do not have permission to do that in this vault.");
  return new HttpError(400, error.message);
}

/**
 * Update the row with this id in the vault, or create it. The app makes the
 * id for a new item, so "has an id" does not mean "exists".
 */
async function upsertRow(
  db: SupabaseClient,
  table: "domains" | "providers",
  vault: Vault,
  id: string,
  row: Record<string, unknown>,
) {
  const kind = table === "domains" ? "domain" : "provider";
  const updated = await db.from(table).update(row)
    .eq("id", id).eq("user_id", vault.ownerId).select().maybeSingle();
  if (updated.error) throw writeError(updated.error, vault, kind);
  if (updated.data) return { saved: updated.data, created: false };

  const inserted = await db.from(table).insert({ id, user_id: vault.ownerId, ...row }).select().single();
  if (inserted.error) throw writeError(inserted.error, vault, kind);
  return { saved: inserted.data, created: true };
}

// deno-lint-ignore no-explicit-any
export async function saveDomain(caller: Caller, db: SupabaseClient, p: any) {
  const vault = await resolveVault(caller, p?.vaultId);
  requirePerm(vault, "editDomains", "add or edit domains");

  const d = p?.domain ?? {};
  const name = str(d.name, 253);
  if (!name) throw new BadRequest("Enter the domain name.");
  const row = {
    name,
    provider_name: str(d.provider, 120),
    purchase_date: dateOrNull(d.purchaseDate, "Purchase date"),
    renewal_date: dateOrNull(d.renewalDate, "Renewal date"),
    purchase_price: amount(d.purchasePrice, "Purchase price"),
    renewal_price: amount(d.renewalPrice, "Renewal price"),
    auto_renew: d.autoRenew === true,
  };

  const { saved, created } = await upsertRow(db, "domains", vault, isUuid(d.id) ? d.id : crypto.randomUUID(), row);
  if (!vault.isOwner) await logActivity(vault.ownerId, caller, created ? "domain.add" : "domain.edit", name);
  return { success: true, domain: toClientDomain(saved) };
}

// deno-lint-ignore no-explicit-any
export async function deleteDomain(caller: Caller, db: SupabaseClient, p: any) {
  const vault = await resolveVault(caller, p?.vaultId);
  requirePerm(vault, "delete", "delete");
  if (!isUuid(p?.id)) throw new BadRequest("id must be a uuid");

  const { data, error } = await db.from("domains").delete()
    .eq("id", p.id).eq("user_id", vault.ownerId).select("name");
  if (error) throw writeError(error, vault, "domain");
  // Already gone (someone else deleted it) is not an error.
  if (data?.length && !vault.isOwner) await logActivity(vault.ownerId, caller, "domain.delete", data[0].name);
  return { success: true };
}

/** Domains point at their provider by name, so they follow a rename. */
async function domainsUsingProvider(ownerId: string, name: string) {
  const { data, error } = await serviceClient().from("domains").select("id, provider_name")
    .eq("user_id", ownerId).not("provider_name", "is", null);
  if (error) throw new HttpError(500, error.message);
  const key = name.trim().toLowerCase();
  return (data ?? []).filter((d) => d.provider_name.trim().toLowerCase() === key).map((d) => d.id as string);
}

// deno-lint-ignore no-explicit-any
export async function saveProvider(caller: Caller, db: SupabaseClient, p: any) {
  const vault = await resolveVault(caller, p?.vaultId);
  requirePerm(vault, "editProviders", "add or edit providers");

  const v = p?.provider ?? {};
  const name = str(v.name, 120);
  if (!name) throw new BadRequest("Enter the provider's name.");
  const id = isUuid(v.id) ? v.id : crypto.randomUUID();
  const row = { name, url: str(v.url, 500), username: str(v.user, 200), uid: str(v.uid, 200) };

  const admin = serviceClient();
  const { data: before } = await admin.from("providers").select("name")
    .eq("id", id).eq("user_id", vault.ownerId).maybeSingle();

  const { saved, created } = await upsertRow(db, "providers", vault, id, row);

  if (before && before.name !== saved.name) {
    const linked = await domainsUsingProvider(vault.ownerId, before.name);
    if (linked.length) {
      const { error } = await admin.from("domains").update({ provider_name: saved.name })
        .eq("user_id", vault.ownerId).in("id", linked);
      if (error) throw new HttpError(500, "The provider was renamed, but its domains were not updated. Save it again.");
    }
  }

  // The password is written separately, encrypted, with the service role.
  // A blank one means "keep what is stored", so a save from a screen that
  // never saw the password cannot erase it.
  let password: "set" | "removed" | null = null;
  if (v.removePassword === true) {
    await admin.from("provider_secrets").delete().eq("provider_id", saved.id).eq("user_id", vault.ownerId);
    password = "removed";
  } else if (typeof v.pass === "string" && v.pass) {
    const { ciphertext, iv } = await encryptSecret(v.pass.slice(0, 512));
    const { error } = await admin.from("provider_secrets").upsert({
      provider_id: saved.id,
      user_id: vault.ownerId,
      ciphertext,
      iv,
      key_version: KEY_VERSION,
      set_at: new Date().toISOString(),
    }, { onConflict: "provider_id" });
    if (error) throw new HttpError(500, "Could not store the provider password.");
    password = "set";
  }

  const { data: secret } = await admin.from("provider_secrets").select("provider_id")
    .eq("provider_id", saved.id).maybeSingle();

  if (!vault.isOwner) {
    await logActivity(vault.ownerId, caller, created ? "provider.add" : "provider.edit", name,
      password ? { password } : {});
  }
  return { success: true, provider: toClientProvider(saved, Boolean(secret)) };
}

// deno-lint-ignore no-explicit-any
export async function deleteProvider(caller: Caller, db: SupabaseClient, p: any) {
  const vault = await resolveVault(caller, p?.vaultId);
  requirePerm(vault, "delete", "delete");
  if (!isUuid(p?.id)) throw new BadRequest("id must be a uuid");

  const { data: provider } = await db.from("providers").select("name")
    .eq("id", p.id).eq("user_id", vault.ownerId).maybeSingle();
  if (!provider) return { success: true };

  if ((await domainsUsingProvider(vault.ownerId, provider.name)).length) {
    throw new HttpError(409, "Cannot delete a provider that still has domains.");
  }
  const { error } = await db.from("providers").delete().eq("id", p.id).eq("user_id", vault.ownerId);
  if (error) throw writeError(error, vault, "provider");
  if (!vault.isOwner) await logActivity(vault.ownerId, caller, "provider.delete", provider.name);
  return { success: true };
}

// deno-lint-ignore no-explicit-any
export async function revealCredential(req: Request, caller: Caller, p: any) {
  if (!isUuid(p?.providerId)) throw new BadRequest("providerId must be a uuid");

  // Deliberately tight: revealing stored passwords is the single most
  // sensitive operation in the product.
  await rateLimit(`reveal:${caller.id}`, 10, 3600);

  const vault = await resolveVault(caller, p?.vaultId);
  requirePerm(vault, "passwords", "see passwords");
  const admin = serviceClient();

  // The vault is checked explicitly because this query uses the service
  // role, which bypasses RLS.
  const { data: row } = await admin
    .from("provider_secrets")
    .select("ciphertext, iv")
    .eq("provider_id", p.providerId)
    .eq("user_id", vault.ownerId)
    .maybeSingle();

  await admin.from("credential_access_log").insert({
    user_id: caller.id,
    provider_id: p.providerId,
    action: row ? "reveal" : "reveal_miss",
    ip: clientIp(req),
    user_agent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
  });

  if (!row) return { success: false, message: "No stored password for that provider." };

  if (!vault.isOwner) {
    const { data: provider } = await admin.from("providers").select("name").eq("id", p.providerId).maybeSingle();
    await logActivity(vault.ownerId, caller, "password.reveal", provider?.name ?? null);
  }
  return { success: true, password: await decryptSecret(row.ciphertext, row.iv) };
}

// ---------------------------------------------------------------------------
// The team screen
// ---------------------------------------------------------------------------

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** 32 random bytes, base64url: 43 characters, matching team_invitations_token_shape. */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function teamError(error: { code?: string; message: string }, vault: Vault) {
  switch (error.code) {
    case "42501":
      return new HttpError(403, "You cannot manage this team.");
    case "P0003": {
      const limit = Number(/of (\d+)\)/.exec(error.message)?.[1] ?? 0);
      const people = limit === 1 ? "is for one person" : `includes ${limit} people, the owner included`;
      return new HttpError(402, vault.isOwner
        ? `Your ${vault.plan} plan ${people}. Upgrade to invite more people.`
        : `The vault's ${vault.plan} plan ${people}. Ask the owner to upgrade.`);
    }
    case "P0001":
      if (/owner/.test(error.message)) return new HttpError(409, "That address belongs to the vault owner.");
      if (/already in the team/.test(error.message)) return new HttpError(409, "That person is already in the team.");
      return new HttpError(409, error.message);
  }
  return new HttpError(400, error.message);
}

/**
 * A team manager who is not the owner can only hand out what they hold
 * themselves; otherwise "manage" would be a way to gain every permission.
 * What the member already has may stay. Reminders are not a privilege.
 */
function checkGrantable(vault: Vault, next: Permissions, current: Permissions | null = null) {
  if (vault.isOwner) return;
  for (const k of PERMS) {
    if (k === "reminders") continue;
    if (next[k] && !current?.[k] && !vault.can[k]) {
      throw new HttpError(403, `You cannot give a permission you do not have yourself (${PERM_LABELS[k]}).`);
    }
  }
}

// deno-lint-ignore no-explicit-any
export async function getTeam(caller: Caller, p: any) {
  const vault = await resolveVault(caller, p?.vaultId);
  requirePerm(vault, "manage", "manage the team");
  const admin = serviceClient();

  const [members, invitations, seats, activity] = await Promise.all([
    admin.from("team_members").select("*").eq("owner_id", vault.ownerId)
      .order("created_at").order("member_id"),
    admin.from("team_invitations").select("*").eq("owner_id", vault.ownerId)
      .is("accepted_at", null).gt("expires_at", new Date().toISOString()).order("created_at"),
    admin.rpc("team_seats", { p_owner: vault.ownerId }).single(),
    admin.from("vault_activity").select("actor_email, action, target, details, created_at")
      .eq("owner_id", vault.ownerId).order("created_at", { ascending: false }).limit(50),
  ]);
  if (members.error) throw new HttpError(500, members.error.message);
  if (seats.error) throw new HttpError(500, seats.error.message);

  const ids = (members.data ?? []).map((m) => m.member_id as string);
  const { data: people } = ids.length
    ? await admin.from("profiles").select("id, email, status").in("id", ids)
    : { data: [] as { id: string; email: string; status: string }[] };
  const byId = new Map((people ?? []).map((u) => [u.id, u]));
  // deno-lint-ignore no-explicit-any
  const limit = (seats.data as any)?.seat_limit as number | null;

  return {
    success: true,
    vault: vaultInfo(vault),
    // deno-lint-ignore no-explicit-any
    seats: { used: Number((seats.data as any)?.used ?? 1), limit },
    members: (members.data ?? []).map((m, i) => {
      const person = byId.get(m.member_id);
      // Same rule as member_can: the owner takes one seat, members fill the
      // rest oldest first.
      const fits = limit === null || i < limit - 1;
      return {
        id: m.member_id,
        email: person?.email ?? "",
        isYou: m.member_id === caller.id,
        joinedAt: m.created_at,
        permissions: permsFromRow(m),
        active: fits && person?.status === "active",
        inactiveReason: !fits ? "over the plan's seats" : person?.status !== "active" ? "account suspended" : null,
      };
    }),
    invitations: (invitations.data ?? []).map((inv) => ({
      email: inv.email,
      sentAt: inv.created_at,
      expiresAt: inv.expires_at,
      permissions: permsFromRow(inv),
    })),
    activity: (activity.data ?? []).map((a) => ({
      actor: a.actor_email,
      action: a.action,
      target: a.target,
      details: a.details,
      at: a.created_at,
    })),
  };
}

// deno-lint-ignore no-explicit-any
export async function inviteMember(caller: Caller, p: any) {
  const vault = await resolveVault(caller, p?.vaultId);
  requirePerm(vault, "manage", "invite people");
  const email = isValidEmail(p?.email) ? p.email.trim().toLowerCase() : null;
  if (!email) throw new BadRequest("Enter a valid email address.");
  const perms = permsFromInput(p?.permissions);
  checkGrantable(vault, perms);

  await rateLimit(`invite:${caller.id}`, 20, 3600);

  const token = newToken();
  const { error } = await serviceClient().rpc("team_invite", {
    p_owner: vault.ownerId,
    p_actor: caller.id,
    p_email: email,
    p_token: token,
    p_perms: perms,
  });
  if (error) throw teamError(error, vault);

  const url = `${SITE_URL}/app/?invite=${token}`;
  const abilities = ["see the vault's domains and providers",
    ...PERMS.filter((k) => perms[k]).map((k) => PERM_LABELS[k])];
  const inviter = caller.email === vault.ownerEmail ? vault.ownerEmail : `${caller.email} (for ${vault.ownerEmail})`;
  const emailed = await sendEmail(
    email,
    "You're invited to a Domain Vault team",
    `<h3>You're invited to a Domain Vault team</h3>
     <p><b>${escapeHtml(inviter)}</b> invited you into their domain vault.</p>
     <p>You will be able to:</p>
     <ul>${abilities.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>
     <p><a href="${url}">Accept the invitation</a></p>
     <p style="color:#777">Log in, or create an account, from the link. It works once and expires in 7 days.
     If you were not expecting this, ignore this email.</p>`,
  );
  await logActivity(vault.ownerId, caller, "team.invite", email, { permissions: perms });

  return {
    success: true,
    emailed,
    // For "copy link", and for when the email could not be sent. Whoever
    // can invite could invite any address of their own anyway.
    inviteUrl: url,
    message: emailed
      ? `Invitation sent to ${email}.`
      : `The email could not be sent. Copy the invitation link and send it to ${email} yourself.`,
  };
}

// deno-lint-ignore no-explicit-any
export async function updateMember(caller: Caller, p: any) {
  const vault = await resolveVault(caller, p?.vaultId);
  requirePerm(vault, "manage", "manage the team");
  if (!isUuid(p?.memberId)) throw new BadRequest("memberId must be a uuid");
  if (p.memberId === caller.id) {
    throw new HttpError(403, "You cannot change your own permissions. Ask the vault owner.");
  }

  const admin = serviceClient();
  const { data: current } = await admin.from("team_members").select("*")
    .eq("owner_id", vault.ownerId).eq("member_id", p.memberId).maybeSingle();
  if (!current) throw new HttpError(404, "That person is no longer in the team.");

  const perms = permsFromInput(p?.permissions);
  checkGrantable(vault, perms, permsFromRow(current));

  const { error } = await admin.from("team_members").update(permColumns(perms))
    .eq("owner_id", vault.ownerId).eq("member_id", p.memberId);
  if (error) throw new HttpError(500, error.message);

  const { data: person } = await admin.from("profiles").select("email").eq("id", p.memberId).maybeSingle();
  await logActivity(vault.ownerId, caller, "team.update", person?.email ?? null, { permissions: perms });
  return { success: true };
}

// deno-lint-ignore no-explicit-any
export async function removeMember(caller: Caller, p: any) {
  const vault = await resolveVault(caller, p?.vaultId);
  requirePerm(vault, "manage", "remove people");
  if (!isUuid(p?.memberId)) throw new BadRequest("memberId must be a uuid");
  if (p.memberId === caller.id) throw new BadRequest("To leave a team, use Leave team.");

  const admin = serviceClient();
  const { data: person } = await admin.from("profiles").select("email").eq("id", p.memberId).maybeSingle();
  const { data, error } = await admin.from("team_members").delete()
    .eq("owner_id", vault.ownerId).eq("member_id", p.memberId).select("member_id");
  if (error) throw new HttpError(500, error.message);
  if (data?.length) await logActivity(vault.ownerId, caller, "team.remove", person?.email ?? null);
  return { success: true };
}

// deno-lint-ignore no-explicit-any
export async function cancelInvitation(caller: Caller, p: any) {
  const vault = await resolveVault(caller, p?.vaultId);
  requirePerm(vault, "manage", "manage the team");
  const email = isValidEmail(p?.email) ? p.email.trim().toLowerCase() : null;
  if (!email) throw new BadRequest("Enter a valid email address.");

  const { data, error } = await serviceClient().from("team_invitations").delete()
    .eq("owner_id", vault.ownerId).eq("email", email).is("accepted_at", null).select("token");
  if (error) throw new HttpError(500, error.message);
  if (data?.length) await logActivity(vault.ownerId, caller, "team.cancel_invite", email);
  return { success: true };
}

/**
 * Leave a team. Works even when the member can no longer open the vault
 * (too few seats, owner suspended): nobody should be stuck in a team.
 */
// deno-lint-ignore no-explicit-any
export async function leaveTeam(caller: Caller, p: any) {
  if (!isUuid(p?.vaultId) || p.vaultId === caller.id) throw new BadRequest("vaultId must be a team vault");
  const { data, error } = await serviceClient().from("team_members").delete()
    .eq("owner_id", p.vaultId).eq("member_id", caller.id).select("member_id");
  if (error) throw new HttpError(500, error.message);
  if (data?.length) await logActivity(p.vaultId, caller, "team.leave", caller.email);
  return { success: true };
}

/**
 * Accept an invitation for this user. The link was emailed to the invitee;
 * holding it is the proof. Also activates an account still waiting for
 * approval: a paying owner vouched for this person.
 */
export async function redeemInvite(req: Request, token: unknown, user: { id: string; email: string }) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) {
    return { ok: false as const, message: "This invitation link is not valid." };
  }
  await rateLimit(`invite-accept:${clientIp(req)}`, 10, 3600);

  const admin = serviceClient();
  const { data: ownerId, error } = await admin.rpc("team_accept", { p_token: token, p_user: user.id });
  if (error) {
    return {
      ok: false as const,
      message: error.code === "P0002"
        ? "This invitation is invalid, already used or expired. Ask for a new one."
        : error.code === "P0003"
        ? "The team has no free seats any more. Ask the vault owner to upgrade, then to invite you again."
        : /own vault/.test(error.message)
        ? "This invitation is for your own vault."
        : "Could not accept the invitation. Ask for a new one.",
    };
  }
  const { data: owner } = await admin.from("profiles").select("email").eq("id", ownerId).maybeSingle();
  await logActivity(ownerId as string, user, "team.join", user.email);
  return { ok: true as const, vaultId: ownerId as string, ownerEmail: owner?.email ?? "" };
}
