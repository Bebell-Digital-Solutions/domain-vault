// ============================================================================
// Customer emails: one branded layout, and texts the owner can edit
//
// Every automated email a customer receives is a template here: a subject, a
// heading, a body and an optional button. The owner edits them in
// Admin → Emails (table email_templates); what is not edited falls back to
// the defaults below. Brand settings (logo, accent colour, footer) live in
// email_settings and apply to every email.
//
// Writing a body: plain text. A blank line starts a new paragraph,
// **double asterisks** make bold, and {{placeholders}} are filled in per
// email. Placeholders listed in `html` are pieces of HTML we build (a table of
// domains, a list); everything else is escaped.
// ============================================================================

import { serviceClient } from "./db.ts";
import { sendEmail } from "./notify.ts";

export interface Template {
  subject: string;
  heading: string;
  body: string;
  button: string;
}

interface Definition extends Template {
  name: string;
  when: string;
  vars: Record<string, string>;   // placeholder → what it is (for the editor)
  html?: string[];                // placeholders that carry HTML
  buttonUrl?: string;             // placeholder holding the button's link
  sample: Record<string, string>; // for previews and test emails
}

const SITE_URL = (Deno.env.get("SITE_URL") ?? "").replace(/\/+$/, "");
const APP_URL = SITE_URL ? `${SITE_URL}/app/` : "";

export const TEMPLATES: Record<string, Definition> = {
  welcome_pending: {
    name: "Welcome (waiting for approval)",
    when: "Sign-up, while new accounts need approval.",
    subject: "Welcome to Domain Vault!",
    heading: "Welcome to Domain Vault!",
    body: "Your account has been created and is pending activation by our team.\n\nWe'll email you as soon as it is live.",
    button: "",
    vars: { email: "Their email address" },
    sample: { email: "customer@example.com" },
  },
  welcome_active: {
    name: "Welcome (account ready)",
    when: "Sign-up, when the account can be used straight away.",
    subject: "Welcome to Domain Vault!",
    heading: "Welcome to Domain Vault!",
    body: "Your account is ready. Log in to start tracking your domains.",
    button: "Open Domain Vault",
    buttonUrl: "app_url",
    vars: { email: "Their email address", app_url: "Link to the app" },
    sample: { email: "customer@example.com" },
  },
  account_activated: {
    name: "Account activated",
    when: "An admin activates a pending account.",
    subject: "Your Domain Vault account is active",
    heading: "You're in!",
    body: "Your Domain Vault account has been activated. You can log in now.",
    button: "Open Domain Vault",
    buttonUrl: "app_url",
    vars: { email: "Their email address", app_url: "Link to the app" },
    sample: { email: "customer@example.com" },
  },
  team_invite: {
    name: "Team invitation",
    when: "Someone is invited into a vault from the Team page.",
    subject: "You're invited to a Domain Vault team",
    heading: "You're invited to a Domain Vault team",
    body: "**{{inviter}}** invited you into their domain vault.\n\nYou will be able to:\n\n{{abilities}}\n\nLog in, or create an account, from the button below. It works once and expires in 7 days. If you were not expecting this, ignore this email.",
    button: "Accept the invitation",
    buttonUrl: "invite_url",
    html: ["abilities"],
    vars: { inviter: "Who invited them", abilities: "List of what they may do", invite_url: "The invitation link" },
    sample: { inviter: "owner@example.com", abilities: "<ul><li>see the vault's domains and providers</li><li>add and edit domains</li></ul>", invite_url: "#" },
  },
  renewal_reminder: {
    name: "Renewal reminder",
    when: "The daily reminder run: one email per person with every domain coming up.",
    subject: "{{summary}}",
    heading: "Renewal reminder",
    body: "{{count_text}} coming up for renewal.\n\n{{domains}}\n\n{{manual_note}}\n\n{{settings_note}}",
    button: "Open Domain Vault",
    buttonUrl: "app_url",
    html: ["domains", "manual_note"],
    vars: {
      summary: "e.g. \"example.com renews tomorrow\" or \"3 domains renewing soon\"",
      count_text: "\"One domain is\" / \"3 domains are\"",
      domains: "Table of the domains, dates and prices",
      manual_note: "A note when some domains do not renew by themselves",
      settings_note: "How to change these reminders (differs for team members)",
      app_url: "Link to the app",
    },
    sample: {
      summary: "2 domains renewing soon — first tomorrow",
      count_text: "2 domains are",
      domains: '<table style="border-collapse:collapse;width:100%"><tr><td style="padding:8px;border-bottom:1px solid #eee"><b>example.com</b></td><td style="padding:8px;border-bottom:1px solid #eee">2026-10-14 (tomorrow) · 12.99</td></tr><tr><td style="padding:8px"><b>example.net</b></td><td style="padding:8px">2026-11-02 (in 20 days)</td></tr></table>',
      manual_note: "Domains marked <b>manual</b> will not renew by themselves.",
      settings_note: "You can change or switch off these reminders in Domain Vault under Settings.",
    },
  },
  purchase_claim: {
    name: "Activate a purchase (paid before signing up)",
    when: "A PayPal payment that matches no account yet, e.g. from the lifetime-deal page.",
    subject: "Activate your Domain Vault {{plan}} plan",
    heading: "Thank you for your purchase!",
    body: "To activate your **{{plan}}** {{what}}, create your Domain Vault account — or log in, if you already have one — with the button below.\n\nThe link works once and stays valid for 30 days. If you did not make this purchase, you can ignore this email.",
    button: "Activate my plan",
    buttonUrl: "claim_url",
    vars: { plan: "Plan name", what: "\"lifetime deal\" or \"subscription\"", claim_url: "The activation link" },
    sample: { plan: "Business", what: "lifetime deal", claim_url: "#" },
  },
  subscription_active: {
    name: "Subscription started",
    when: "The first payment of a yearly subscription.",
    subject: "Your Domain Vault {{plan}} subscription is active",
    heading: "Thank you for subscribing!",
    body: "Your **{{plan}}** plan is active{{plan_note}}. PayPal renews it automatically each year; the next renewal is due around **{{renews}}**.\n\nYou can cancel any time in PayPal ({{manage_link}}); your plan then stays active until the end of the year you paid for.\n\nTransaction: {{txn}}",
    button: "Open Domain Vault",
    buttonUrl: "app_url",
    html: ["plan_note", "manage_link"],
    vars: { plan: "Plan name", plan_note: "Their plan if a higher one applies", renews: "Next renewal date", manage_link: "Link to PayPal automatic payments", txn: "PayPal transaction id", app_url: "Link to the app" },
    sample: { plan: "Business", plan_note: "", renews: "2027-10-13", manage_link: '<a href="#">automatic payments</a>', txn: "9AB12345CD678901E" },
  },
  lifetime_active: {
    name: "Lifetime deal activated",
    when: "A lifetime-deal payment for an existing account.",
    subject: "Your Domain Vault {{plan}} lifetime deal is active",
    heading: "Thank you for your purchase!",
    body: "Your **{{plan}}** lifetime plan is now active on your account{{plan_note}}.\n\nTransaction: {{txn}}",
    button: "Open Domain Vault",
    buttonUrl: "app_url",
    html: ["plan_note"],
    vars: { plan: "Plan name", plan_note: "Their plan if a higher one applies", txn: "PayPal transaction id", app_url: "Link to the app" },
    sample: { plan: "Business", plan_note: "", txn: "9AB12345CD678901E" },
  },
  subscription_duplicate: {
    name: "Second subscription warning",
    when: "A customer starts a subscription while another one is still active.",
    subject: "You have more than one Domain Vault subscription",
    heading: "You have more than one subscription",
    body: "Your new **{{plan}}** subscription is set up. You also still have: {{others}}.\n\nTo avoid paying twice, cancel the one you no longer need in PayPal: {{manage_link}}. Your plan is always the highest one you pay for.",
    button: "",
    html: ["manage_link"],
    vars: { plan: "New plan", others: "The other subscriptions", manage_link: "Link to PayPal automatic payments" },
    sample: { plan: "Agency", others: "Business (I-ABC123)", manage_link: '<a href="#">automatic payments</a>' },
  },
  subscription_cancelled: {
    name: "Subscription cancelled",
    when: "The customer cancels in PayPal.",
    subject: "Your Domain Vault {{plan}} subscription was cancelled",
    heading: "Subscription cancelled",
    body: "Your **{{plan}}** subscription has been cancelled, so it will not renew.\n\n{{until_text}}",
    button: "Open Domain Vault",
    buttonUrl: "app_url",
    vars: { plan: "Plan name", until_text: "\"You keep your plan until …\" (empty if unknown)", app_url: "Link to the app" },
    sample: { plan: "Business", until_text: "You keep your plan until 2027-10-13." },
  },
  subscription_ended: {
    name: "Subscription ended",
    when: "The paid year of a cancelled subscription is over.",
    subject: "Your Domain Vault {{plan}} subscription has ended",
    heading: "Subscription ended",
    body: "Your **{{plan}}** subscription has ended. Your plan is now **{{plan_now}}**.\n\nYour domains are kept; you can subscribe again any time from the app.",
    button: "Open Domain Vault",
    buttonUrl: "app_url",
    vars: { plan: "Plan that ended", plan_now: "Their plan now", app_url: "Link to the app" },
    sample: { plan: "Business", plan_now: "Personal" },
  },
  payment_failed: {
    name: "Renewal payment failed",
    when: "PayPal could not collect a yearly renewal.",
    subject: "Your Domain Vault renewal payment failed",
    heading: "Your renewal payment failed",
    body: "PayPal could not collect the renewal for your **{{plan}}** plan. PayPal will try again; please check your payment method in {{manage_link}}.\n\n{{until_text}}",
    button: "",
    html: ["manage_link"],
    vars: { plan: "Plan name", manage_link: "Link to PayPal", until_text: "\"Your plan stays active until …\" (empty if unknown)" },
    sample: { plan: "Business", manage_link: '<a href="#">PayPal</a>', until_text: "Your plan stays active until 2027-10-16." },
  },
};

export interface Brand {
  logo_url: string;
  accent_color: string;
  footer_text: string;
}

export const DEFAULT_BRAND: Brand = {
  logo_url: "https://ik.imagekit.io/bebell/Domain%20Vault/domain-assets-logos/Domain-vault-logo.webp",
  accent_color: "#ff5011",
  footer_text: "Domain Vault · getdomainvault.com",
};

function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// Edited texts and brand are read once per minute per function instance: the
// reminder run sends many emails in a row.
let cache: { at: number; templates: Map<string, Partial<Template>>; brand: Brand } | null = null;

export async function loadEmailSettings(fresh = false) {
  if (!fresh && cache && Date.now() - cache.at < 60000) return cache;
  const admin = serviceClient();
  const [{ data: rows }, { data: brand }] = await Promise.all([
    admin.from("email_templates").select("key, subject, heading, body, button"),
    admin.from("email_settings").select("logo_url, accent_color, footer_text").eq("id", true).maybeSingle(),
  ]);
  cache = {
    at: Date.now(),
    templates: new Map((rows ?? []).map((r) => [r.key, r])),
    brand: { ...DEFAULT_BRAND, ...(brand ?? {}) },
  };
  return cache;
}

/** The text in use: the owner's edit, else the default. */
export function effectiveTemplate(key: string, edited?: Partial<Template>): Template {
  const def = TEMPLATES[key];
  return {
    subject: edited?.subject ?? def.subject,
    heading: edited?.heading ?? def.heading,
    body: edited?.body ?? def.body,
    button: edited?.button ?? def.button,
  };
}

function fill(text: string, vars: Record<string, string>, htmlVars: string[], escape: boolean) {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, name) => {
    const v = vars[name] ?? "";
    return escape && !htmlVars.includes(name) ? escapeHtml(v) : v;
  });
}

/** Body text → HTML paragraphs: blank line = new paragraph, **bold**. */
function bodyHtml(body: string, vars: Record<string, string>, htmlVars: string[]) {
  return escapeHtml(body)
    // Placeholders survive escaping unchanged; fill them after.
    .split(/\n\s*\n/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => {
      const filled = fill(para.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>"), vars, htmlVars, true);
      if (!filled.trim()) return "";
      // A paragraph that is only a block of HTML (a table, a list) is not wrapped.
      return /^\s*<(table|ul|ol|div)/i.test(filled) ? filled : `<p style="margin:0 0 14px">${filled}</p>`;
    })
    .join("\n");
}

export function renderEmail(key: string, template: Template, brand: Brand, vars: Record<string, string>) {
  const def = TEMPLATES[key];
  const htmlVars = def.html ?? [];
  const all: Record<string, string> = { app_url: APP_URL, ...vars };
  const accent = /^#[0-9a-f]{6}$/i.test(brand.accent_color) ? brand.accent_color : DEFAULT_BRAND.accent_color;
  const logo = /^https:\/\/[^\s"<>]+$/.test(brand.logo_url) ? brand.logo_url : "";
  const buttonUrl = def.buttonUrl ? all[def.buttonUrl] : "";
  const button = template.button && buttonUrl
    ? `<p style="margin:22px 0 4px"><a href="${escapeHtml(buttonUrl)}" style="display:inline-block;background:${accent};color:#ffffff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:600">${escapeHtml(fill(template.button, all, [], false))}</a></p>`
    : "";
  const subject = fill(template.subject, all, [], false).replace(/[\r\n]+/g, " ").trim();
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;font-family:system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111111;font-size:15px;line-height:1.55">
<tr><td style="background:#0b0b0b;border-bottom:3px solid ${accent};padding:18px 28px">
${logo ? `<img src="${escapeHtml(logo)}" width="36" height="36" alt="" style="vertical-align:middle;border-radius:8px">` : ""}
<span style="vertical-align:middle;color:#ffffff;font-weight:700;letter-spacing:2px;margin-left:10px">DOMAIN VAULT</span>
</td></tr>
<tr><td style="padding:28px">
<h2 style="margin:0 0 16px;font-size:21px;color:#111111">${escapeHtml(fill(template.heading, all, [], false))}</h2>
${bodyHtml(template.body, all, htmlVars)}
${button}
</td></tr>
<tr><td style="padding:16px 28px;background:#fafafa;border-top:1px solid #eeeeee;color:#888888;font-size:12px">${escapeHtml(brand.footer_text)}</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, html };
}

/** Send one of the templates above, with the owner's current text and brand. */
export async function sendTemplate(to: string, key: string, vars: Record<string, string>) {
  if (!TEMPLATES[key]) throw new Error(`unknown email template ${key}`);
  const settings = await loadEmailSettings().catch(() => null);
  const template = effectiveTemplate(key, settings?.templates.get(key));
  const { subject, html } = renderEmail(key, template, settings?.brand ?? DEFAULT_BRAND, vars);
  return sendEmail(to, subject, html);
}
