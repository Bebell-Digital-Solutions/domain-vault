// ============================================================================
// Calendar subscription feed
//
// GET /functions/v1/calendar?token=<feed token>  →  text/calendar
//
// Google Calendar, Apple Calendar and Outlook poll this URL ("subscribe from
// URL") and show every renewal date. A calendar app cannot send headers, so
// the token in the URL is the only credential; gateway JWT verification is
// off for this function (config.toml) for the same reason.
//
// An unknown token, a malformed one, and a suspended account all get the same
// 404, so the endpoint does not confirm which tokens exist.
// ============================================================================

import { HttpError, rateLimit, serviceClient } from "../_shared/db.ts";

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

interface FeedRow {
  domain_id: string;
  domain_name: string;
  provider_name: string | null;
  renewal_date: string;
  renewal_price: number | null;
  auto_renew: boolean;
}

/** RFC 5545 TEXT escaping. */
function icsText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Fold content lines at 75 octets, as RFC 5545 requires. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) {
      out.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join("\r\n ");
}

const compactDate = (iso: string) => iso.slice(0, 10).replace(/-/g, "");

function nextDay(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function buildCalendar(rows: FeedRow[]): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Bebell Digital Solutions//Domain Vault//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Domain Vault renewals",
    "X-WR-CALDESC:Renewal dates of the domains in your Domain Vault",
    "REFRESH-INTERVAL;VALUE=DURATION:PT12H",
    "X-PUBLISHED-TTL:PT12H",
  ];

  for (const r of rows) {
    const details = [
      r.provider_name ? `Provider: ${r.provider_name}` : null,
      r.renewal_price !== null ? `Renewal price: ${Number(r.renewal_price).toFixed(2)}` : null,
      `Auto-renew: ${r.auto_renew ? "on" : "off"}`,
    ].filter(Boolean).join("\n");

    lines.push(
      "BEGIN:VEVENT",
      // Stable per renewal cycle: a renewed domain is a new event, an edited
      // price updates the existing one.
      `UID:${r.domain_id}-${compactDate(r.renewal_date)}@domain-vault`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compactDate(r.renewal_date)}`,
      `DTEND;VALUE=DATE:${nextDay(r.renewal_date)}`,
      `SUMMARY:${icsText(`Renew ${r.domain_name}`)}`,
      `DESCRIPTION:${icsText(details)}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

function notFound(): Response {
  return new Response("Not found\n", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("GET only\n", { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!TOKEN_RE.test(token)) return notFound();

  try {
    // Calendar apps poll every few hours; this is generous for them and
    // useless for anyone trying to hammer one feed.
    await rateLimit(`calendar:${token}`, 120, 3600);

    const { data, error } = await serviceClient().rpc("calendar_feed", { p_token: token });
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as FeedRow[];
    if (rows.length === 0) {
      // Distinguish "valid feed, no dated domains yet" from "no such feed"
      // without revealing anything to someone guessing tokens.
      const { data: feed } = await serviceClient()
        .from("calendar_feeds").select("user_id").eq("token", token).maybeSingle();
      const { data: profile } = feed
        ? await serviceClient().from("profiles").select("status").eq("id", feed.user_id)
          .maybeSingle()
        : { data: null };
      if (!profile || profile.status !== "active") return notFound();
    }

    return new Response(req.method === "HEAD" ? null : buildCalendar(rows), {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="domain-vault-renewals.ics"',
        "Cache-Control": "private, max-age=900",
      },
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return new Response(`${err.message}\n`, { status: err.status });
    }
    console.error("calendar feed failed", err);
    return new Response("Calendar unavailable\n", { status: 500 });
  }
});
