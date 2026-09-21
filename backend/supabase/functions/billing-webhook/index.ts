// ============================================================================
// PayPal payment webhook (IPN)
//
// Business model: PayPal only, one-time purchase of a domain pack, no
// subscription. Every notification is:
//
//   1. Verified with PayPal. Anything PayPal does not confirm is ignored.
//   2. Checked against our own receiver account.
//   3. Deduplicated per (transaction, status), so a replay never applies twice
//      but a Pending payment that later clears as Completed still applies.
//   4. Checked against plan_prices — exact amount and currency. PayPal's
//      verification only proves a payment is genuine, not that it paid the
//      right price for the right pack; anyone can create a genuine 0.01
//      payment to our account labelled "Agency".
//   5. Written to the purchases ledger. The user's plan is then recomputed
//      from that ledger, so refunds and chargebacks take back exactly what
//      the payment granted.
//
// Anything that needs a human (wrong amount, unknown email, refund,
// chargeback) is recorded and emailed to ADMIN_EMAIL.
// ============================================================================

import { serviceClient } from "../_shared/db.ts";
import { sendEmail } from "../_shared/notify.ts";

type Plan = "Start-up" | "Business" | "Agency";

const PAYPAL_ENV = Deno.env.get("PAYPAL_ENV") ?? "live";
const VERIFY_URLS: Record<string, string | undefined> = {
  live: "https://ipnpb.paypal.com/cgi-bin/webscr",
  sandbox: "https://ipnpb.sandbox.paypal.com/cgi-bin/webscr",
  // Local automated tests only: points at a stub that answers VERIFIED.
  test: Deno.env.get("PAYPAL_VERIFY_URL"),
};
const VERIFY_URL = VERIFY_URLS[PAYPAL_ENV];

const RECEIVER = (Deno.env.get("PAYPAL_RECEIVER_EMAIL") ?? "").trim().toLowerCase();
const ADMIN_EMAIL = Deno.env.get("ADMIN_EMAIL");
const SITE_URL = Deno.env.get("SITE_URL") ?? "";

const ok = (msg: string) => new Response(msg, { status: 200 });
// A 5xx makes PayPal retry later — used only for faults we can fix.
const retryLater = (msg: string) => new Response(msg, { status: 500 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The pack a payment is for. item_number is the reliable field (set it to
 * startup / business / agency on each PayPal button); item_name is a
 * fallback for buttons created without one.
 */
function planFor(params: URLSearchParams): Plan | null {
  const code = (params.get("item_number") ?? "").trim().toLowerCase().replace(/[\s_-]/g, "");
  if (code === "startup") return "Start-up";
  if (code === "business") return "Business";
  if (code === "agency") return "Agency";

  const name = params.get("item_name") ?? "";
  if (/agency/i.test(name)) return "Agency";
  if (/business/i.test(name)) return "Business";
  if (/start[\s-]?up/i.test(name)) return "Start-up";
  return null;
}

const cents = (v: unknown) => Math.round(Number(v) * 100);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

async function verifyWithPayPal(rawBody: string): Promise<boolean> {
  if (!VERIFY_URL) return false;
  try {
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "DomainVault-IPN/2.0",
      },
      body: `cmd=_notify-validate&${rawBody}`,
    });
    return (await res.text()).trim() === "VERIFIED";
  } catch (err) {
    console.error("IPN verification request failed", err);
    return false;
  }
}

async function alertAdmin(subject: string, lines: Record<string, unknown>) {
  if (!ADMIN_EMAIL) return;
  const rows = Object.entries(lines)
    .map(([k, v]) => `<tr><td><b>${escapeHtml(k)}</b></td><td>${escapeHtml(String(v ?? "-"))}</td></tr>`)
    .join("");
  await sendEmail(
    ADMIN_EMAIL,
    `[Domain Vault] ${subject}`,
    `<h3>${escapeHtml(subject)}</h3><table>${rows}</table>
     ${SITE_URL ? `<p><a href="${SITE_URL}/admin.html">Open the admin panel</a></p>` : ""}`,
  );
}

async function recompute(userId: string | null) {
  if (!userId) return null;
  const { data, error } = await serviceClient().rpc("recompute_plan", { p_user: userId });
  if (error) throw new Error(`recompute_plan failed: ${error.message}`);
  return data as string;
}

// ---------------------------------------------------------------------------
// Status handlers
// ---------------------------------------------------------------------------

async function handleCompleted(p: URLSearchParams, txnId: string): Promise<Response> {
  const db = serviceClient();
  const email = (p.get("custom") ?? "").trim().toLowerCase();
  const payerEmail = (p.get("payer_email") ?? "").trim().toLowerCase();
  const plan = planFor(p);
  const gross = p.get("mc_gross");
  const tax = p.get("tax") ?? "0";
  const currency = (p.get("mc_currency") ?? "").toUpperCase();

  const { data: existing } = await db
    .from("purchases").select("id, status").eq("txn_id", txnId).maybeSingle();
  if (existing?.status === "completed") return ok("already applied");

  const record = async (status: string, reason: string | null, userId: string | null) => {
    const { error } = await db.from("purchases").upsert({
      txn_id: txnId,
      user_id: userId,
      email: email || null,
      payer_email: payerEmail || null,
      plan,
      amount: gross === null ? null : Number(gross),
      currency: currency || null,
      status,
      reason,
    }, { onConflict: "txn_id" });
    if (error) throw new Error(`could not record purchase: ${error.message}`);
  };

  // --- the right pack, at the right price, in the right currency ---------
  if (!plan) {
    await record("rejected", `unknown pack: ${p.get("item_number") ?? ""} / ${p.get("item_name") ?? ""}`, null);
    await alertAdmin("Payment for an unknown pack", { txnId, email, item: p.get("item_name"), gross, currency });
    return ok("unknown pack");
  }

  const { data: price } = await db
    .from("plan_prices").select("amount, currency").eq("plan", plan).maybeSingle();

  if (!price || price.amount === null) {
    await record("rejected", `no price configured for ${plan}`, null);
    await alertAdmin("Payment for a pack with no price set", { txnId, email, plan, gross, currency });
    return ok("pack not priced");
  }

  const paidNet = cents(gross) - cents(tax);
  if (paidNet !== cents(price.amount) || currency !== price.currency) {
    await record(
      "rejected",
      `amount mismatch: paid ${gross} ${currency} (tax ${tax}), expected ${price.amount} ${price.currency}`,
      null,
    );
    await alertAdmin("Payment with the wrong amount — NOT applied", {
      txnId, email, plan, paid: `${gross} ${currency}`, expected: `${price.amount} ${price.currency}`,
    });
    return ok("amount mismatch");
  }

  // --- whose account ------------------------------------------------------
  const { data: profile } = email
    ? await db.from("profiles").select("id, email").eq("email", email).maybeSingle()
    : { data: null };

  if (!profile) {
    await record("unmatched", `no account for "${email}"`, null);
    await alertAdmin("Payment received but no matching account", {
      txnId, accountEmail: email, payerEmail, plan, paid: `${gross} ${currency}`,
    });
    return ok("no matching account");
  }

  await record("completed", null, profile.id);
  const effective = await recompute(profile.id);

  await sendEmail(
    profile.email,
    `Your Domain Vault ${plan} pack is active`,
    `<h3>Thank you for your purchase!</h3>
     <p>Your <b>${plan}</b> pack is now active on your account${
      effective && effective !== plan ? ` (your current plan is <b>${effective}</b>)` : ""
    }.</p>
     <p>Transaction: ${escapeHtml(txnId)}</p>
     ${SITE_URL ? `<p><a href="${SITE_URL}">Open Domain Vault</a></p>` : ""}`,
  );

  return ok("applied");
}

async function handlePending(p: URLSearchParams, txnId: string): Promise<Response> {
  const db = serviceClient();
  const { data: existing } = await db
    .from("purchases").select("status").eq("txn_id", txnId).maybeSingle();
  if (existing) return ok("already recorded");

  await db.from("purchases").insert({
    txn_id: txnId,
    email: (p.get("custom") ?? "").trim().toLowerCase() || null,
    payer_email: (p.get("payer_email") ?? "").trim().toLowerCase() || null,
    plan: planFor(p),
    amount: p.get("mc_gross") === null ? null : Number(p.get("mc_gross")),
    currency: (p.get("mc_currency") ?? "").toUpperCase() || null,
    status: "pending",
    reason: `pending: ${p.get("pending_reason") ?? "unspecified"}`,
  });
  return ok("pending recorded");
}

/** Refunded or Reversed. These arrive with their own txn_id; parent_txn_id is the sale. */
async function handleReversal(p: URLSearchParams, txnId: string, status: string): Promise<Response> {
  const db = serviceClient();
  const parent = p.get("parent_txn_id");
  if (!parent) return ok("reversal without parent");

  const { data: sale } = await db
    .from("purchases").select("id, user_id, email, plan, amount, currency, status, reason")
    .eq("txn_id", parent).maybeSingle();

  if (!sale) {
    await alertAdmin(`${status} for a payment we have no record of`, { txnId, parent, gross: p.get("mc_gross") });
    return ok("unknown parent");
  }

  const returned = Math.abs(cents(p.get("mc_gross")));
  const full = status === "Reversed" || sale.amount === null || returned >= cents(sale.amount);

  if (!full) {
    // A partial refund (a goodwill credit, say) does not take the pack away.
    await db.from("purchases").update({
      reason: [sale.reason, `partial refund ${p.get("mc_gross")} ${p.get("mc_currency")} (${txnId})`]
        .filter(Boolean).join("; "),
    }).eq("id", sale.id);
    await alertAdmin("Partial refund — pack kept", { parent, refund: txnId, amount: p.get("mc_gross"), email: sale.email });
    return ok("partial refund noted");
  }

  await db.from("purchases").update({
    status: status === "Reversed" ? "reversed" : "refunded",
    reason: `${status.toLowerCase()} by ${txnId}${p.get("reason_code") ? ` (${p.get("reason_code")})` : ""}`,
  }).eq("id", sale.id);

  const effective = await recompute(sale.user_id);
  await alertAdmin(`${status === "Reversed" ? "Chargeback" : "Refund"} — pack withdrawn`, {
    parent, [status.toLowerCase()]: txnId, email: sale.email, pack: sale.plan, planNow: effective,
  });
  return ok(`${status.toLowerCase()} applied`);
}

/** A chargeback was decided in our favour: give the pack back. */
async function handleCanceledReversal(p: URLSearchParams): Promise<Response> {
  const db = serviceClient();
  const parent = p.get("parent_txn_id");
  if (!parent) return ok("no parent");

  const { data: sale } = await db
    .from("purchases").select("id, user_id, email, status").eq("txn_id", parent).maybeSingle();
  if (!sale || sale.status !== "reversed") return ok("nothing to restore");

  await db.from("purchases").update({ status: "completed", reason: "chargeback cancelled" }).eq("id", sale.id);
  const effective = await recompute(sale.user_id);
  await alertAdmin("Chargeback cancelled — pack restored", { parent, email: sale.email, planNow: effective });
  return ok("restored");
}

/** Denied / Failed / Voided / Expired refer to the same txn_id as the pending sale. */
async function handleFailed(p: URLSearchParams, txnId: string, status: string): Promise<Response> {
  const db = serviceClient();
  const { data: sale } = await db
    .from("purchases").select("id, user_id, status").eq("txn_id", txnId).maybeSingle();
  if (!sale) return ok("nothing recorded");

  await db.from("purchases").update({ status: "failed", reason: status.toLowerCase() }).eq("id", sale.id);
  await recompute(sale.user_id);
  return ok("marked failed");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  if (!RECEIVER || !VERIFY_URL) {
    console.error("billing-webhook misconfigured: PAYPAL_RECEIVER_EMAIL / PAYPAL_ENV");
    return retryLater("not configured");
  }

  const rawBody = await req.text();
  const p = new URLSearchParams(rawBody);

  if (!await verifyWithPayPal(rawBody)) {
    console.warn("ignored unverified IPN", p.get("txn_id"));
    return ok("not verified");
  }

  const receiver = (p.get("receiver_email") ?? p.get("business") ?? "").trim().toLowerCase();
  if (receiver !== RECEIVER) {
    console.warn("ignored IPN for another receiver", receiver);
    return ok("wrong receiver");
  }

  const txnId = p.get("txn_id");
  const status = p.get("payment_status") ?? "";
  if (!txnId || !status) return ok("not a payment notification");

  const db = serviceClient();
  const { error: dupe } = await db.from("webhook_events").insert({
    id: `${txnId}:${status}`,
    provider: "paypal",
    event_type: status,
    user_email: (p.get("custom") ?? "").toLowerCase() || null,
    payload: Object.fromEntries(p.entries()),
  });

  if (dupe) {
    if (dupe.code === "23505") return ok("duplicate");
    console.error("could not log webhook", dupe.message);
    return retryLater("logging failed");
  }

  try {
    switch (status) {
      case "Completed":
        return await handleCompleted(p, txnId);
      case "Pending":
        return await handlePending(p, txnId);
      case "Refunded":
      case "Reversed":
        return await handleReversal(p, txnId, status);
      case "Canceled_Reversal":
        return await handleCanceledReversal(p);
      case "Denied":
      case "Failed":
      case "Voided":
      case "Expired":
        return await handleFailed(p, txnId, status);
      default:
        return ok(`ignored status ${status}`);
    }
  } catch (err) {
    // Undo the dedupe marker so PayPal's retry is processed, not skipped.
    await db.from("webhook_events").delete().eq("id", `${txnId}:${status}`);
    console.error("IPN processing failed", err);
    return retryLater("processing failed");
  }
});
