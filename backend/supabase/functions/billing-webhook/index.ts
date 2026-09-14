// ============================================================================
// Payment webhook
//
// The Apps Script version upgraded any account whose email appeared in an
// unauthenticated POST with payment_status=Completed. Anyone could forge that
// and grant themselves the Agency plan.
//
// This version:
//   1. Verifies the notification with PayPal before believing a word of it.
//   2. Confirms the payment is addressed to our own receiver account.
//   3. Records the provider-side transaction id, so a replayed webhook cannot
//      apply twice.
// ============================================================================

import { serviceClient } from "../_shared/db.ts";
import { sendEmail } from "../_shared/notify.ts";

const PAYPAL_VERIFY_URL = Deno.env.get("PAYPAL_ENV") === "sandbox"
  ? "https://ipnpb.sandbox.paypal.com/cgi-bin/webscr"
  : "https://ipnpb.paypal.com/cgi-bin/webscr";

const PAYPAL_RECEIVER = (Deno.env.get("PAYPAL_RECEIVER_EMAIL") ?? "").toLowerCase();

const PLAN_BY_KEYWORD: [RegExp, string][] = [
  [/agency/i, "Agency"],
  [/business/i, "Business"],
  [/start[\s-]?up/i, "Start-up"],
  [/personal/i, "Personal"],
];

function planFromItemName(itemName: string): string | null {
  for (const [pattern, plan] of PLAN_BY_KEYWORD) {
    if (pattern.test(itemName)) return plan;
  }
  return null;
}

/** Ask PayPal whether it actually sent this. Anything but VERIFIED is a forgery. */
async function verifyWithPayPal(rawBody: string): Promise<boolean> {
  const res = await fetch(PAYPAL_VERIFY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "DomainVault-IPN/1.0",
    },
    body: `cmd=_notify-validate&${rawBody}`,
  });
  return (await res.text()).trim() === "VERIFIED";
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  const rawBody = await req.text();
  const params = new URLSearchParams(rawBody);

  if (!await verifyWithPayPal(rawBody)) {
    console.warn("rejected unverified IPN", params.get("txn_id"));
    // 200 so PayPal stops retrying a message we will never accept.
    return new Response("IPN not verified", { status: 200 });
  }

  const txnId = params.get("txn_id");
  const status = params.get("payment_status");
  const receiver = (params.get("receiver_email") ?? "").toLowerCase();
  const email = (params.get("custom") ?? params.get("payer_email") ?? "").toLowerCase().trim();
  const itemName = params.get("item_name") ?? "";

  if (!txnId) return new Response("missing txn_id", { status: 200 });

  if (PAYPAL_RECEIVER && receiver !== PAYPAL_RECEIVER) {
    console.warn("IPN for a different receiver", receiver);
    return new Response("wrong receiver", { status: 200 });
  }

  const admin = serviceClient();

  // Idempotency: the primary key rejects a replay outright.
  const { error: dupe } = await admin.from("webhook_events").insert({
    id: txnId,
    provider: "paypal",
    event_type: status,
    user_email: email,
    payload: Object.fromEntries(params.entries()),
  });

  if (dupe) {
    if (dupe.code === "23505") return new Response("already processed", { status: 200 });
    console.error("webhook log failed", dupe.message);
    return new Response("logging failed", { status: 500 });
  }

  if (status !== "Completed") return new Response("ignored", { status: 200 });

  const plan = planFromItemName(itemName);
  if (!plan || !email) return new Response("nothing to apply", { status: 200 });

  const { data: profile } = await admin
    .from("profiles").select("id, email").eq("email", email).maybeSingle();

  if (!profile) {
    console.warn("paid but no matching account", email);
    return new Response("no matching account", { status: 200 });
  }

  // Activate on payment: someone who has paid should not also wait on manual
  // approval.
  const { error } = await admin
    .from("profiles")
    .update({ plan, status: "active" })
    .eq("id", profile.id);

  if (error) {
    console.error("plan upgrade failed", error.message);
    return new Response("upgrade failed", { status: 500 });
  }

  await sendEmail(
    profile.email,
    `Your Domain Vault plan is now ${plan}`,
    `<h3>Thank you!</h3><p>Your account has been upgraded to <b>${plan}</b> and is active.</p>`,
  );

  return new Response("ok", { status: 200 });
});
