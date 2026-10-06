// ============================================================================
// PayPal payment webhook (IPN)
//
// Business model: PayPal only. Each plan (Personal, Start-up, Business,
// Agency) is sold as a yearly subscription, and optionally as a one-time
// "lifetime deal". Every notification is:
//
//   1. Verified with PayPal. Anything PayPal does not confirm is ignored.
//   2. Checked against our own receiver account.
//   3. Deduplicated: payments per (transaction, status), so a replay never
//      applies twice but a Pending payment that later clears as Completed
//      still applies; subscription events per (event, subscription).
//   4. Checked against plan_prices — exact amount and currency, for the kind
//      of payment: subscriptions against the yearly price, one-time payments
//      against the lifetime price. PayPal's verification only proves a
//      payment is genuine, not that it paid the right price for the right
//      plan; anyone can create a genuine 0.01 payment to our account
//      labelled "Agency", or a one-time payment of the yearly price.
//   5. Written to the purchases ledger. A subscription payment grants its
//      plan until a year (the subscription's period) after the payment, plus
//      grace; a lifetime payment has no end. The user's plan is then
//      recomputed from that ledger, so refunds, chargebacks and lapsed
//      subscriptions take back exactly what the payment granted.
//
// Subscription lifecycle messages (signup, cancel, end of term, failed
// renewal) are recorded in `subscriptions`, for the customer's billing page
// and the admin panel. Anything that needs a human is emailed to ADMIN_EMAIL.
// ============================================================================

import { serviceClient } from "../_shared/db.ts";
import { sendEmail } from "../_shared/notify.ts";

type Plan = "Personal" | "Start-up" | "Business" | "Agency";
type Kind = "subscription" | "lifetime";

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
const MANAGE_URL = "https://www.paypal.com/myaccount/autopay/";

const SUBSCRIPTION_EVENTS = new Set([
  "subscr_signup", "subscr_cancel", "subscr_eot", "subscr_failed", "subscr_modify",
]);

const ok = (msg: string) => new Response(msg, { status: 200 });
// A 5xx makes PayPal retry later — used only for faults we can fix.
const retryLater = (msg: string) => new Response(msg, { status: 500 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The plan a payment is for. item_number is the reliable field (personal /
 * startup / start-up / business / agency on each PayPal button); item_name is
 * a fallback for buttons created without one.
 */
function planFor(params: URLSearchParams): Plan | null {
  const code = (params.get("item_number") ?? "").trim().toLowerCase().replace(/[\s_-]/g, "");
  if (code === "personal") return "Personal";
  if (code === "startup") return "Start-up";
  if (code === "business") return "Business";
  if (code === "agency") return "Agency";

  const name = params.get("item_name") ?? "";
  if (/agency/i.test(name)) return "Agency";
  if (/business/i.test(name)) return "Business";
  if (/start[\s-]?up/i.test(name)) return "Start-up";
  if (/personal/i.test(name)) return "Personal";
  return null;
}

const cents = (v: unknown) => Math.round(Number(v) * 100);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const day = (d: Date | string | null) => d ? new Date(d).toISOString().slice(0, 10) : "";

/** PayPal's own date format, e.g. "09:34:27 Oct 06, 2026 PDT". Null if unreadable. */
function paypalDate(value: string | null): Date | null {
  const m = /^(\d{2}):(\d{2}):(\d{2}) (\w{3}) (\d{1,2}), (\d{4}) (PST|PDT)$/.exec((value ?? "").trim());
  if (!m) return null;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    .indexOf(m[4]);
  if (month < 0) return null;
  const offset = m[7] === "PDT" ? 7 : 8;
  return new Date(Date.UTC(+m[6], month, +m[5], +m[1] + offset, +m[2], +m[3]));
}

/** Add a PayPal billing period ("1 Y", "12 M", "4 W", "30 D") to a date. */
function addPeriod(from: Date, period: string | null): Date {
  const m = /^(\d+)\s*([DWMY])$/i.exec((period ?? "").trim());
  const n = m ? Number(m[1]) : 1;
  const unit = m ? m[2].toUpperCase() : "Y";
  const d = new Date(from);
  if (unit === "Y") d.setUTCFullYear(d.getUTCFullYear() + n);
  else if (unit === "M") d.setUTCMonth(d.getUTCMonth() + n);
  else if (unit === "W") d.setUTCDate(d.getUTCDate() + 7 * n);
  else d.setUTCDate(d.getUTCDate() + n);
  return d;
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
     ${SITE_URL ? `<p><a href="${SITE_URL}/app/admin.html">Open the admin panel</a></p>` : ""}`,
  );
}

const appLink = () => SITE_URL ? `<p><a href="${SITE_URL}/app/">Open Domain Vault</a></p>` : "";

async function recompute(userId: string | null) {
  if (!userId) return null;
  const { data, error } = await serviceClient().rpc("recompute_plan", { p_user: userId });
  if (error) throw new Error(`recompute_plan failed: ${error.message}`);
  return data as string;
}

/**
 * Whose account a notification is for. `custom` carries the account email
 * the app sent to PayPal. A payment started outside the app (a plain button
 * on a web page) has none; then the payer's PayPal email is used if an
 * account has that address — PayPal has verified it, so it cannot be used to
 * credit someone else's account against their will.
 */
async function matchAccount(p: URLSearchParams) {
  const db = serviceClient();
  const custom = (p.get("custom") ?? "").trim().toLowerCase();
  const payer = (p.get("payer_email") ?? "").trim().toLowerCase();
  for (const email of [custom, payer]) {
    if (!email) continue;
    const { data } = await db.from("profiles").select("id, email").eq("email", email).maybeSingle();
    if (data) return { profile: data as { id: string; email: string }, email: custom || payer, payer };
    if (custom) break;   // an explicit account that does not exist: do not guess
  }
  return { profile: null, email: custom || payer, payer };
}

async function prices(plan: Plan) {
  const { data } = await serviceClient()
    .from("plan_prices").select("amount, lifetime_amount, currency").eq("plan", plan).maybeSingle();
  return data as { amount: number | null; lifetime_amount: number | null; currency: string } | null;
}

async function graceDays(): Promise<number> {
  const { data } = await serviceClient().from("billing_config").select("grace_days").eq("id", true)
    .maybeSingle();
  return data?.grace_days ?? 3;
}

// ---------------------------------------------------------------------------
// Payments (one-time and subscription), by payment_status
// ---------------------------------------------------------------------------

async function handleCompleted(p: URLSearchParams, txnId: string, kind: Kind): Promise<Response> {
  const db = serviceClient();
  const plan = planFor(p);
  const gross = p.get("mc_gross");
  const tax = p.get("tax") ?? "0";
  const currency = (p.get("mc_currency") ?? "").toUpperCase();
  const subscrId = p.get("subscr_id");
  const { profile, email, payer } = await matchAccount(p);

  const { data: existing } = await db
    .from("purchases").select("id, status").eq("txn_id", txnId).maybeSingle();
  if (existing?.status === "completed") return ok("already applied");

  const record = async (status: string, reason: string | null, userId: string | null, paidUntil: string | null = null) => {
    const { error } = await db.from("purchases").upsert({
      txn_id: txnId,
      user_id: userId,
      email: email || null,
      payer_email: payer || null,
      plan,
      amount: gross === null ? null : Number(gross),
      currency: currency || null,
      status,
      reason,
      kind,
      subscr_id: subscrId,
      paid_until: paidUntil,
    }, { onConflict: "txn_id" });
    if (error) throw new Error(`could not record purchase: ${error.message}`);
  };

  // --- the right plan, at the right price for this kind, in the right currency
  if (!plan) {
    await record("rejected", `unknown plan: ${p.get("item_number") ?? ""} / ${p.get("item_name") ?? ""}`, null);
    await alertAdmin("Payment for an unknown plan", { txnId, kind, email, item: p.get("item_name"), gross, currency });
    return ok("unknown plan");
  }

  const price = await prices(plan);
  const expected = kind === "subscription" ? price?.amount : price?.lifetime_amount;
  const label = kind === "subscription" ? "yearly subscription" : "lifetime deal";

  if (!price || expected === null || expected === undefined) {
    await record("rejected", `no ${label} price configured for ${plan}`, null);
    await alertAdmin(`Payment for a ${label} with no price set — NOT applied`, { txnId, email, plan, gross, currency });
    return ok("plan not priced");
  }

  const paidNet = cents(gross) - cents(tax);
  if (paidNet !== cents(expected) || currency !== price.currency) {
    await record(
      "rejected",
      `amount mismatch: paid ${gross} ${currency} (tax ${tax}), expected ${expected} ${price.currency} (${label})`,
      null,
    );
    await alertAdmin("Payment with the wrong amount — NOT applied", {
      txnId, kind, email, plan, paid: `${gross} ${currency}`, expected: `${expected} ${price.currency}`,
    });
    return ok("amount mismatch");
  }

  // --- whose account ------------------------------------------------------
  if (!profile) {
    await record("unmatched", `no account for "${email}"`, null);
    await alertAdmin("Payment received but no matching account", {
      txnId, kind, accountEmail: email, payerEmail: payer, plan, paid: `${gross} ${currency}`,
    });
    return ok("no matching account");
  }

  // --- how long it grants -------------------------------------------------
  let paidUntil: string | null = null;
  if (kind === "subscription") {
    const { data: sub } = subscrId
      ? await db.from("subscriptions").select("period").eq("subscr_id", subscrId).maybeSingle()
      : { data: null };
    const paidAt = paypalDate(p.get("payment_date")) ?? new Date();
    const until = addPeriod(paidAt, sub?.period ?? "1 Y");
    until.setUTCDate(until.getUTCDate() + await graceDays());
    paidUntil = until.toISOString();
  }

  await record("completed", null, profile.id, paidUntil);
  const effective = await recompute(profile.id);
  const note = effective && effective !== plan ? ` (your current plan is <b>${effective}</b>)` : "";

  if (kind === "subscription") {
    const renews = addPeriod(paypalDate(p.get("payment_date")) ?? new Date(), "1 Y");
    await sendEmail(
      profile.email,
      `Your Domain Vault ${plan} subscription is active`,
      `<h3>Thank you for subscribing!</h3>
       <p>Your <b>${plan}</b> plan is active${note}. PayPal renews it automatically each year;
       the next renewal is due around <b>${day(renews)}</b>.</p>
       <p>You can cancel any time in PayPal (<a href="${MANAGE_URL}">automatic payments</a>);
       your plan then stays active until the end of the year you paid for.</p>
       <p>Transaction: ${escapeHtml(txnId)}</p>${appLink()}`,
    );
  } else {
    await sendEmail(
      profile.email,
      `Your Domain Vault ${plan} lifetime deal is active`,
      `<h3>Thank you for your purchase!</h3>
       <p>Your <b>${plan}</b> lifetime plan is now active on your account${note}.</p>
       <p>Transaction: ${escapeHtml(txnId)}</p>${appLink()}`,
    );
  }

  return ok("applied");
}

async function handlePending(p: URLSearchParams, txnId: string, kind: Kind): Promise<Response> {
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
    kind,
    subscr_id: p.get("subscr_id"),
  });
  return ok("pending recorded");
}

/** Refunded or Reversed. These arrive with their own txn_id; parent_txn_id is the sale. */
async function handleReversal(p: URLSearchParams, txnId: string, status: string): Promise<Response> {
  const db = serviceClient();
  const parent = p.get("parent_txn_id");
  if (!parent) return ok("reversal without parent");

  const { data: sale } = await db
    .from("purchases").select("id, user_id, email, plan, amount, currency, status, reason, kind")
    .eq("txn_id", parent).maybeSingle();

  if (!sale) {
    await alertAdmin(`${status} for a payment we have no record of`, { txnId, parent, gross: p.get("mc_gross") });
    return ok("unknown parent");
  }

  const returned = Math.abs(cents(p.get("mc_gross")));
  const full = status === "Reversed" || sale.amount === null || returned >= cents(sale.amount);

  if (!full) {
    // A partial refund (a goodwill credit, say) does not take the plan away.
    await db.from("purchases").update({
      reason: [sale.reason, `partial refund ${p.get("mc_gross")} ${p.get("mc_currency")} (${txnId})`]
        .filter(Boolean).join("; "),
    }).eq("id", sale.id);
    await alertAdmin("Partial refund — plan kept", { parent, refund: txnId, amount: p.get("mc_gross"), email: sale.email });
    return ok("partial refund noted");
  }

  await db.from("purchases").update({
    status: status === "Reversed" ? "reversed" : "refunded",
    reason: `${status.toLowerCase()} by ${txnId}${p.get("reason_code") ? ` (${p.get("reason_code")})` : ""}`,
  }).eq("id", sale.id);

  const effective = await recompute(sale.user_id);
  await alertAdmin(`${status === "Reversed" ? "Chargeback" : "Refund"} — plan withdrawn`, {
    parent, [status.toLowerCase()]: txnId, email: sale.email, plan: sale.plan, kind: sale.kind, planNow: effective,
    ...(sale.kind === "subscription"
      ? { note: "The subscription itself may still be active in PayPal; cancel it there if needed." }
      : {}),
  });
  return ok(`${status.toLowerCase()} applied`);
}

/** A chargeback was decided in our favour: give the plan back. */
async function handleCanceledReversal(p: URLSearchParams): Promise<Response> {
  const db = serviceClient();
  const parent = p.get("parent_txn_id");
  if (!parent) return ok("no parent");

  const { data: sale } = await db
    .from("purchases").select("id, user_id, email, status").eq("txn_id", parent).maybeSingle();
  if (!sale || sale.status !== "reversed") return ok("nothing to restore");

  await db.from("purchases").update({ status: "completed", reason: "chargeback cancelled" }).eq("id", sale.id);
  const effective = await recompute(sale.user_id);
  await alertAdmin("Chargeback cancelled — plan restored", { parent, email: sale.email, planNow: effective });
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
// Subscription lifecycle (no money moves in these messages)
// ---------------------------------------------------------------------------

async function handleSubscriptionEvent(p: URLSearchParams, event: string, subscrId: string): Promise<Response> {
  const db = serviceClient();
  const { data: sub } = await db.from("subscriptions")
    .select("subscr_id, user_id, email, plan, status").eq("subscr_id", subscrId).maybeSingle();

  if (event === "subscr_signup") {
    const plan = planFor(p);
    const amount = p.get("mc_amount3") ?? p.get("amount3");
    const currency = (p.get("mc_currency") ?? "").toUpperCase();
    const period = (p.get("period3") ?? "").trim().toUpperCase() || "1 Y";
    const { profile, email, payer } = await matchAccount(p);

    let status = "active";
    let reason: string | null = null;
    const price = plan ? await prices(plan) : null;
    if (!plan) {
      status = "rejected"; reason = `unknown plan: ${p.get("item_number") ?? ""} / ${p.get("item_name") ?? ""}`;
    } else if (!price || price.amount === null) {
      status = "rejected"; reason = `no yearly price configured for ${plan}`;
    } else if (cents(amount) !== cents(price.amount) || currency !== price.currency) {
      status = "rejected"; reason = `amount mismatch: ${amount} ${currency}, expected ${price.amount} ${price.currency}`;
    } else if (!/^(1 Y|12 M)$/.test(period)) {
      status = "rejected"; reason = `unexpected billing period ${period}, expected yearly`;
    } else if (!profile) {
      status = "unmatched"; reason = `no account for "${email}"`;
    }

    const { error } = await db.from("subscriptions").upsert({
      subscr_id: subscrId,
      user_id: profile?.id ?? null,
      email: email || null,
      payer_email: payer || null,
      plan,
      amount: amount === null ? null : Number(amount),
      currency: currency || null,
      period,
      status,
      reason,
    }, { onConflict: "subscr_id" });
    if (error) throw new Error(`could not record subscription: ${error.message}`);

    if (status !== "active") {
      await alertAdmin(`Subscription ${status} — check it in PayPal`, { subscrId, email, payer, plan, amount, currency, period, reason });
      return ok(`subscription ${status}`);
    }

    // Someone upgrading by starting a second subscription keeps paying for
    // the first one until they cancel it. PayPal gives us no way to cancel
    // it for them, so say so.
    const { data: others } = await db.from("subscriptions").select("subscr_id, plan")
      .eq("user_id", profile!.id).eq("status", "active").neq("subscr_id", subscrId);
    if (others && others.length > 0) {
      const list = others.map((o) => `${o.plan} (${o.subscr_id})`).join(", ");
      await alertAdmin("Customer now has more than one active subscription", { email, newPlan: plan, older: list });
      await sendEmail(
        profile!.email,
        "You have more than one Domain Vault subscription",
        `<p>Your new <b>${escapeHtml(plan!)}</b> subscription is set up. You also still have:
         ${escapeHtml(list)}.</p>
         <p>To avoid paying twice, cancel the one you no longer need in PayPal:
         <a href="${MANAGE_URL}">automatic payments</a>. Your plan is always the highest one you pay for.</p>`,
      );
    }
    return ok("subscription recorded");
  }

  if (!sub) {
    await alertAdmin(`PayPal ${event} for a subscription we have no record of`, { subscrId, payer: p.get("payer_email") });
    return ok("unknown subscription");
  }

  const { data: last } = await db.from("purchases").select("paid_until")
    .eq("subscr_id", subscrId).eq("status", "completed")
    .order("paid_until", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
  const until = last?.paid_until ?? null;
  const { data: owner } = sub.user_id
    ? await db.from("profiles").select("email").eq("id", sub.user_id).maybeSingle()
    : { data: null };

  if (event === "subscr_cancel") {
    if (sub.status === "active") {
      await db.from("subscriptions").update({ status: "cancelled", cancelled_at: new Date().toISOString() })
        .eq("subscr_id", subscrId);
    }
    if (owner) {
      await sendEmail(
        owner.email,
        `Your Domain Vault ${sub.plan} subscription was cancelled`,
        `<p>Your <b>${escapeHtml(sub.plan ?? "")}</b> subscription has been cancelled, so it will not renew.</p>
         ${until ? `<p>You keep your plan until <b>${day(until)}</b>.</p>` : ""}${appLink()}`,
      );
    }
    await alertAdmin("Subscription cancelled", { subscrId, email: sub.email, plan: sub.plan, activeUntil: day(until) });
    return ok("cancellation recorded");
  }

  if (event === "subscr_eot") {
    await db.from("subscriptions").update({ status: "ended", ended_at: new Date().toISOString() })
      .eq("subscr_id", subscrId);
    // End of term: whatever this subscription paid for is over now, even if
    // our own clock said a few days of grace were left.
    await db.from("purchases").update({ paid_until: new Date().toISOString() })
      .eq("subscr_id", subscrId).eq("status", "completed").gt("paid_until", new Date().toISOString());
    const effective = await recompute(sub.user_id);
    if (owner) {
      await sendEmail(
        owner.email,
        `Your Domain Vault ${sub.plan} subscription has ended`,
        `<p>Your <b>${escapeHtml(sub.plan ?? "")}</b> subscription has ended. Your plan is now
         <b>${escapeHtml(effective ?? "")}</b>. Your domains are kept; you can subscribe again any time
         from the app.</p>${appLink()}`,
      );
    }
    await alertAdmin("Subscription ended", { subscrId, email: sub.email, plan: sub.plan, planNow: effective });
    return ok("end of term applied");
  }

  if (event === "subscr_failed") {
    if (owner) {
      await sendEmail(
        owner.email,
        "Your Domain Vault renewal payment failed",
        `<p>PayPal could not collect the renewal for your <b>${escapeHtml(sub.plan ?? "")}</b> plan.
         PayPal will try again; please check your payment method in
         <a href="${MANAGE_URL}">PayPal</a>.</p>
         ${until ? `<p>Your plan stays active until <b>${day(until)}</b>.</p>` : ""}`,
      );
    }
    await alertAdmin("Subscription renewal failed", { subscrId, email: sub.email, plan: sub.plan, activeUntil: day(until) });
    return ok("failure noted");
  }

  // subscr_modify: rare (changes made in PayPal). Record and let a human look.
  await db.from("subscriptions").update({ reason: `modified in PayPal ${new Date().toISOString()}` })
    .eq("subscr_id", subscrId);
  await alertAdmin("Subscription modified in PayPal — please review", {
    subscrId, email: sub.email, plan: sub.plan, newAmount: p.get("mc_amount3") ?? p.get("amount3"),
    newItem: p.get("item_number"),
  });
  return ok("modification noted");
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
    console.warn("ignored unverified IPN", p.get("txn_id") ?? p.get("subscr_id"));
    return ok("not verified");
  }

  const receiver = (p.get("receiver_email") ?? p.get("business") ?? "").trim().toLowerCase();
  if (receiver !== RECEIVER) {
    console.warn("ignored IPN for another receiver", receiver);
    return ok("wrong receiver");
  }

  const txnType = (p.get("txn_type") ?? "").trim();
  const txnId = p.get("txn_id");
  const status = p.get("payment_status") ?? "";
  const subscrId = p.get("subscr_id");

  let eventId: string;
  if (SUBSCRIPTION_EVENTS.has(txnType)) {
    if (!subscrId) return ok("subscription event without subscr_id");
    // One signup, cancel or end per subscription; failures and changes can
    // repeat, and PayPal's replays keep the same ipn_track_id.
    eventId = ["subscr_failed", "subscr_modify"].includes(txnType)
      ? `${txnType}:${subscrId}:${p.get("ipn_track_id") ?? Date.now()}`
      : `${txnType}:${subscrId}`;
  } else {
    if (!txnId || !status) return ok("not a payment notification");
    eventId = `${txnId}:${status}`;
  }

  const db = serviceClient();
  const { error: dupe } = await db.from("webhook_events").insert({
    id: eventId,
    provider: "paypal",
    event_type: SUBSCRIPTION_EVENTS.has(txnType) ? txnType : status,
    user_email: (p.get("custom") ?? "").toLowerCase() || null,
    payload: Object.fromEntries(p.entries()),
  });

  if (dupe) {
    if (dupe.code === "23505") return ok("duplicate");
    console.error("could not log webhook", dupe.message);
    return retryLater("logging failed");
  }

  // A payment belongs to a subscription if PayPal says so (subscr_payment)
  // or it carries a subscription id; everything else is one-time.
  const kind: Kind = txnType === "subscr_payment" || subscrId ? "subscription" : "lifetime";

  try {
    if (SUBSCRIPTION_EVENTS.has(txnType)) return await handleSubscriptionEvent(p, txnType, subscrId!);

    switch (status) {
      case "Completed":
        return await handleCompleted(p, txnId!, kind);
      case "Pending":
        return await handlePending(p, txnId!, kind);
      case "Refunded":
      case "Reversed":
        return await handleReversal(p, txnId!, status);
      case "Canceled_Reversal":
        return await handleCanceledReversal(p);
      case "Denied":
      case "Failed":
      case "Voided":
      case "Expired":
        return await handleFailed(p, txnId!, status);
      default:
        return ok(`ignored status ${status}`);
    }
  } catch (err) {
    // Undo the dedupe marker so PayPal's retry is processed, not skipped.
    await db.from("webhook_events").delete().eq("id", eventId);
    console.error("IPN processing failed", err);
    return retryLater("processing failed");
  }
});
