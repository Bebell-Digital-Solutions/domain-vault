// ============================================================================
// Daily renewal reminder sweep
//
// Replaces checkRenewalsAndNotify. Differences that matter:
//   * Idempotent. Each (domain, days-out, channel) reminder is recorded, and
//     the unique index means a re-run — or an overlapping run — cannot send a
//     duplicate. The old version re-sent everything if the trigger fired twice.
//   * Queries only the three dates it cares about instead of scanning every
//     row and computing dates in a loop.
//   * A single user's bad phone number or bounced address no longer aborts
//     the rest of the sweep.
// ============================================================================

import { serviceClient } from "../_shared/db.ts";
import { sendEmail, sendWhatsApp } from "../_shared/notify.ts";

const LEAD_DAYS = [30, 7, 1];
const SITE_URL = Deno.env.get("SITE_URL") ?? "";

function isoDateInDays(days: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Constant-time string comparison, so the secret cannot be guessed by timing. */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * Only the scheduler may run this: pg_cron presents x-cron-secret, and an
 * operator running it by hand may present the service role key instead.
 */
function authorized(req: Request): boolean {
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
  const presented = req.headers.get("x-cron-secret") ?? "";
  if (cronSecret.length >= 32 && safeEqual(presented, cronSecret)) return true;

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const bearer = req.headers.get("Authorization") ?? "";
  return serviceKey.length > 0 && safeEqual(bearer, `Bearer ${serviceKey}`);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  if (!authorized(req)) return new Response("forbidden", { status: 403 });

  const admin = serviceClient();
  const targets = new Map(LEAD_DAYS.map((d) => [isoDateInDays(d), d]));

  const { data: domains, error } = await admin
    .from("domains")
    .select("id, user_id, name, renewal_date, renewal_price, auto_renew")
    .in("renewal_date", [...targets.keys()]);

  if (error) {
    console.error("reminder query failed", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  if (!domains?.length) {
    return new Response(JSON.stringify({ checked: 0, sent: 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // One profile lookup for the whole sweep rather than one per domain.
  const userIds = [...new Set(domains.map((d) => d.user_id))];
  const { data: profiles } = await admin
    .from("profiles")
    .select("id, email, phone, status")
    .in("id", userIds);

  const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));

  let sent = 0;
  let skipped = 0;

  for (const domain of domains) {
    const profile = profileById.get(domain.user_id);
    if (!profile || profile.status !== "active") {
      skipped++;
      continue;
    }

    const diffDays = targets.get(domain.renewal_date as string)!;

    for (const channel of ["email", "whatsapp"] as const) {
      if (channel === "whatsapp" && !profile.phone) continue;

      // Claim the reminder first. If the insert conflicts, another run already
      // sent this one, so we must not send again.
      const { error: claimError } = await admin.from("notifications").insert({
        user_id: profile.id,
        domain_id: domain.id,
        domain_name: domain.name,
        diff_days: diffDays,
        type: "renewal",
        channel,
      });

      if (claimError) {
        if (claimError.code !== "23505") console.error("claim failed", claimError.message);
        continue;
      }

      const ok = channel === "email"
        ? await sendEmail(
          profile.email,
          `Domain renewal reminder: ${domain.name}`,
          `<h3>${escapeHtml(domain.name)} expires in ${diffDays} day${diffDays === 1 ? "" : "s"}</h3>
           <p>Renewal date: <b>${domain.renewal_date}</b></p>
           ${domain.auto_renew ? "<p>Auto-renew is on for this domain.</p>" : ""}
           ${SITE_URL ? `<p><a href="${SITE_URL}">Open Domain Vault</a></p>` : ""}`,
        )
        : await sendWhatsApp(
          profile.phone,
          `Reminder: your domain ${domain.name} expires in ${diffDays} day${
            diffDays === 1 ? "" : "s"
          }.`,
        );

      if (ok) {
        sent++;
      } else {
        // Delivery failed, so release the claim and let tomorrow's run retry.
        await admin.from("notifications")
          .delete()
          .eq("domain_id", domain.id)
          .eq("diff_days", diffDays)
          .eq("channel", channel)
          .eq("type", "renewal");
      }
    }
  }

  return new Response(JSON.stringify({ checked: domains.length, sent, skipped }), {
    headers: { "Content-Type": "application/json" },
  });
});
