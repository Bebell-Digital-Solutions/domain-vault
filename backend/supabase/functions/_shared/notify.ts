// Outbound email and WhatsApp.
//
// Both helpers no-op when their credentials are absent, so the stack runs
// locally and in CI without secrets and without throwing.
//
// Email moved off Apps Script's MailApp (hard quota, sends from the owner's
// personal Google account) to a transactional provider.

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const MAIL_FROM = Deno.env.get("MAIL_FROM") ?? "Domain Vault <noreply@example.com>";

const WHATSAPP_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
const WHATSAPP_PHONE_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
): Promise<boolean> {
  if (!RESEND_API_KEY) {
    console.log(`[email skipped: no RESEND_API_KEY] to=${to} subject=${subject}`);
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: MAIL_FROM, to, subject, html }),
    });
    if (!res.ok) {
      console.error("email send failed", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("email send threw", err);
    return false;
  }
}

export async function sendWhatsApp(phone: string | null, message: string): Promise<boolean> {
  if (!phone || !WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) return false;

  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length < 8) return false;

  try {
    const res = await fetch(
      `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: digits,
          type: "text",
          text: { body: message },
        }),
      },
    );
    if (!res.ok) {
      console.error("whatsapp send failed", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("whatsapp send threw", err);
    return false;
  }
}
