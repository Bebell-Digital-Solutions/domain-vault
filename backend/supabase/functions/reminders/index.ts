// ============================================================================
// Daily renewal reminder sweep
//
// All the "who should hear about what" logic lives in the due_reminders SQL
// function, where it is covered by the test suite. This function's job is to
// claim, send, and record — and to leave the claim off if the send failed, so
// tomorrow tries again.
//
// One digest per user per channel: ten domains renewing the same week is one
// email, not ten.
//
// Team members whose owner ticked "receives reminders" get a copy of the
// owner's email digest, on the owner's schedule, once it has been delivered.
// ============================================================================

import { serviceClient } from "../_shared/db.ts";
import { sendEmail, sendWhatsApp } from "../_shared/notify.ts";

const SITE_URL = Deno.env.get("SITE_URL") ?? "";
const CHANNELS = ["email", "whatsapp"] as const;

interface Due {
  user_id: string;
  email: string;
  phone: string | null;
  domain_id: string;
  domain_name: string;
  renewal_date: string;
  renewal_price: number | null;
  auto_renew: boolean;
  provider_name: string | null;
  days_left: number;
  milestone: number;
}

/** Constant-time comparison, so the secret cannot be guessed by timing. */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** pg_cron presents x-cron-secret; an operator may present the service key. */
function authorized(req: Request): boolean {
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
  if (cronSecret.length >= 32 && safeEqual(req.headers.get("x-cron-secret") ?? "", cronSecret)) {
    return true;
  }
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return serviceKey.length > 0 &&
    safeEqual(req.headers.get("Authorization") ?? "", `Bearer ${serviceKey}`);
}

function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function money(amount: number | null): string {
  return amount === null || Number(amount) === 0 ? "" : ` · ${Number(amount).toFixed(2)}`;
}

function whenText(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

function subjectFor(rows: Due[]): string {
  const soonest = rows[0];
  if (rows.length === 1) {
    return `${soonest.domain_name} renews ${whenText(soonest.days_left)}`;
  }
  return `${rows.length} domains renewing soon — first ${whenText(soonest.days_left)}`;
}

/** The digest; `teamOf` is the owner's address when this is a team member's copy. */
function emailBody(rows: Due[], teamOf: string | null = null): string {
  const items = rows.map((r) => `
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #eee">
        <b>${escapeHtml(r.domain_name)}</b>${
    r.provider_name ? ` <span style="color:#777">· ${escapeHtml(r.provider_name)}</span>` : ""
  }
      </td>
      <td style="padding:10px 14px;border-bottom:1px solid #eee;white-space:nowrap">
        ${escapeHtml(r.renewal_date)} (${escapeHtml(whenText(r.days_left))})${escapeHtml(money(r.renewal_price))}
      </td>
      <td style="padding:10px 14px;border-bottom:1px solid #eee;color:#777;white-space:nowrap">
        ${r.auto_renew ? "auto-renew on" : "manual"}
      </td>
    </tr>`).join("");

  const anyManual = rows.some((r) => !r.auto_renew);

  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111">
      <h2 style="margin:0 0 6px">Renewal reminder</h2>
      <p style="margin:0 0 18px;color:#555">
        ${rows.length === 1 ? "One domain is" : `${rows.length} domains are`} coming up for renewal.
      </p>
      <table style="border-collapse:collapse;width:100%;max-width:600px">${items}</table>
      ${
    anyManual
      ? `<p style="margin:18px 0 0;color:#555">Domains marked <b>manual</b> will not renew by
           themselves — renew them with your registrar before the date above.</p>`
      : ""
  }
      ${SITE_URL ? `<p style="margin:18px 0 0"><a href="${SITE_URL}/app/">Open Domain Vault</a></p>` : ""}
      <p style="margin:22px 0 0;font-size:12px;color:#999">
        ${
    teamOf
      ? `You receive these as a member of the domain vault of ${escapeHtml(teamOf)}.
         The vault owner can switch them off for you on the Team page.`
      : "You can change or switch off these reminders in Domain Vault under Settings."
  }
      </p>
    </div>`;
}

function whatsappBody(rows: Due[]): string {
  const lines = rows.slice(0, 10).map((r) =>
    `• ${r.domain_name} — ${whenText(r.days_left)} (${r.renewal_date})${r.auto_renew ? " [auto]" : ""}`
  );
  if (rows.length > 10) lines.push(`…and ${rows.length - 10} more`);
  return `Domain Vault renewal reminder:\n${lines.join("\n")}`;
}

/** Email the owner's digest to the team members chosen for it. Returns how many were sent. */
async function copyToTeam(admin: ReturnType<typeof serviceClient>, owner: Due, rows: Due[]): Promise<number> {
  const { data, error } = await admin.rpc("team_reminder_recipients", { p_owner: owner.user_id });
  if (error) {
    console.error("team_reminder_recipients failed", error.message);
    return 0;
  }
  let sent = 0;
  for (const member of (data ?? []) as { member_id: string; email: string }[]) {
    if (await sendEmail(member.email, subjectFor(rows), emailBody(rows, owner.email))) sent++;
  }
  return sent;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  if (!authorized(req)) return new Response("forbidden", { status: 403 });

  const admin = serviceClient();
  const summary = { due: 0, sent: 0, recipients: 0, failed: 0, teamCopies: 0 };

  for (const channel of CHANNELS) {
    const { data, error } = await admin.rpc("due_reminders", { p_channel: channel });
    if (error) {
      console.error(`due_reminders(${channel}) failed`, error.message);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const rows = (data ?? []) as Due[];
    summary.due += rows.length;

    // One digest per user.
    const byUser = new Map<string, Due[]>();
    for (const row of rows) {
      const list = byUser.get(row.user_id) ?? [];
      list.push(row);
      byUser.set(row.user_id, list);
    }

    for (const [, userRows] of byUser) {
      userRows.sort((a, b) => a.days_left - b.days_left);
      const who = userRows[0];

      // Claim first: if two sweeps overlap, only one inserts these rows and
      // only one sends. A failed send releases the claim below.
      const claims = userRows.map((r) => ({
        user_id: r.user_id,
        domain_id: r.domain_id,
        domain_name: r.domain_name,
        renewal_date: r.renewal_date,
        diff_days: r.milestone,
        type: "renewal",
        channel,
      }));

      const { data: inserted, error: claimError } = await admin
        .from("notifications").insert(claims).select("id, domain_id, diff_days");

      if (claimError) {
        if (claimError.code !== "23505") console.error("claim failed", claimError.message);
        continue;   // another run already has these
      }

      const ok = channel === "email"
        ? await sendEmail(who.email, subjectFor(userRows), emailBody(userRows))
        : await sendWhatsApp(who.phone, whatsappBody(userRows));

      if (ok) {
        summary.sent += userRows.length;
        summary.recipients++;
        // Only after the owner's copy went out: a failed send is retried
        // tomorrow, and the team must not get the same digest twice.
        if (channel === "email") summary.teamCopies += await copyToTeam(admin, who, userRows);
      } else {
        summary.failed += userRows.length;
        // Release the claim so the next sweep retries. Without this a failed
        // send would be recorded as delivered and never tried again.
        const ids = (inserted ?? []).map((r) => r.id);
        if (ids.length) await admin.from("notifications").delete().in("id", ids);
      }
    }
  }

  return new Response(JSON.stringify(summary), {
    headers: { "Content-Type": "application/json" },
  });
});
