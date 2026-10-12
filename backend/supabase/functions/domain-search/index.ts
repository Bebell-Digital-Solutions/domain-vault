// ============================================================================
// Domain search — is a name free, and where is it cheapest to own?
//
// Public (the tool on the website is for everyone; links to registrars may
// carry affiliate codes). Rate limited per IP.
//
//   action "search"         { domain }  availability + price comparison
//   action "refreshPrices"  (cron secret, service key or an admin)
//                           reload Porkbun's prices from its public list
//
// Availability comes from the registry itself over RDAP, found through IANA's
// bootstrap file: 404 = not registered, 200 = registered (with registrar,
// creation and expiry dates). Registries without RDAP (.io, .co, most country
// codes) get a DNS check instead: a name that does not exist in DNS is
// "likely available", which the result says plainly.
//
// Prices come from registrar_prices, never from registrars at search time:
// list prices change monthly, not per search, and registrar APIs ration
// their quotas. The 5-year cost is first year + 4 renewals.
// ============================================================================

import { json, preflight } from "../_shared/cors.ts";
import { clientIp, HttpError, rateLimit, requireAdmin, serviceClient } from "../_shared/db.ts";
import { BadRequest, isValidDomain } from "../_shared/validate.ts";

const BOOTSTRAP_TTL = 24 * 60 * 60;
const AVAILABILITY_TTL = 10 * 60;
const UPSTREAM_TIMEOUT_MS = 6000;
const RESTRICTED = new Set(["edu", "gov", "mil", "int", "arpa"]);
// Offered when the name is taken, in this order.
const ALTERNATIVE_TLDS = ["com", "net", "org", "io", "co", "app", "dev", "ai", "xyz", "online", "tech"];
const MAX_ALTERNATIVES = 6;

type Status = "available" | "likely_available" | "registered" | "unknown";

interface Availability {
  status: Status;
  source: "rdap" | "dns" | "none";
  registration: { registrar: string | null; created: string | null; expires: string | null } | null;
}

// ---------------------------------------------------------------------------
// Cache (the lookup function's table)
// ---------------------------------------------------------------------------

async function cached<T>(key: string, ttl: number, produce: () => Promise<T>, keep: (v: T) => boolean = () => true) {
  const admin = serviceClient();
  const { data: hit } = await admin.from("lookup_cache").select("payload, expires_at").eq("key", key).maybeSingle();
  if (hit && new Date(hit.expires_at) > new Date()) return hit.payload as T;
  const fresh = await produce();
  if (keep(fresh)) {
    await admin.from("lookup_cache").upsert({
      key,
      payload: fresh,
      expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
    }, { onConflict: "key" });
  }
  return fresh;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** TLD → the registry's RDAP base URL, from IANA's bootstrap file. */
function rdapBootstrap(): Promise<Record<string, string>> {
  return cached("rdap:bootstrap", BOOTSTRAP_TTL, async () => {
    const res = await fetchWithTimeout("https://data.iana.org/rdap/dns.json", {}, 10000);
    if (!res.ok) throw new HttpError(502, "The registry directory is unavailable. Try again shortly.");
    const data = await res.json();
    const map: Record<string, string> = {};
    for (const [tlds, urls] of data.services ?? []) {
      const url = (urls as string[]).find((u) => u.startsWith("https://")) ?? (urls as string[])[0];
      for (const tld of tlds as string[]) if (url) map[tld.toLowerCase()] = url.endsWith("/") ? url : url + "/";
    }
    return map;
  });
}

// deno-lint-ignore no-explicit-any
function vcardName(entity: any): string | null {
  const card = entity?.vcardArray?.[1];
  if (!Array.isArray(card)) return null;
  // deno-lint-ignore no-explicit-any
  const fn = card.find((f: any) => Array.isArray(f) && f[0] === "fn");
  return typeof fn?.[3] === "string" && fn[3].trim() ? fn[3].trim() : null;
}

// deno-lint-ignore no-explicit-any
function parseRdap(data: any) {
  // deno-lint-ignore no-explicit-any
  const registrar = (data?.entities ?? []).find((e: any) => (e.roles ?? []).includes("registrar"));
  // deno-lint-ignore no-explicit-any
  const event = (action: string) => (data?.events ?? []).find((e: any) => e.eventAction === action)?.eventDate ?? null;
  const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
  return {
    registrar: vcardName(registrar),
    created: day(event("registration")),
    expires: day(event("expiration")),
  };
}

async function dnsCheck(domain: string): Promise<Availability> {
  try {
    const res = await fetchWithTimeout(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=NS`,
      { headers: { accept: "application/dns-json" } },
      4000,
    );
    if (!res.ok) return { status: "unknown", source: "none", registration: null };
    const data = await res.json();
    if (data.Status === 3) return { status: "likely_available", source: "dns", registration: null };
    if (data.Status === 0) return { status: "registered", source: "dns", registration: null };
  } catch { /* fall through */ }
  return { status: "unknown", source: "none", registration: null };
}

function checkAvailability(domain: string): Promise<Availability> {
  return cached(`avail:${domain}`, AVAILABILITY_TTL, async (): Promise<Availability> => {
    const tld = domain.split(".").pop()!;
    const base = (await rdapBootstrap())[tld];
    if (base) {
      try {
        const res = await fetchWithTimeout(`${base}domain/${encodeURIComponent(domain)}`, {
          headers: { accept: "application/rdap+json, application/json" },
        });
        if (res.status === 404) {
          await res.body?.cancel();
          return { status: "available", source: "rdap", registration: null };
        }
        if (res.ok) {
          return { status: "registered", source: "rdap", registration: parseRdap(await res.json()) };
        }
        await res.body?.cancel();
      } catch { /* the registry is slow or down: ask DNS instead */ }
    }
    return dnsCheck(domain);
  }, (v) => v.status !== "unknown");
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

interface PriceRow {
  id: string;
  name: string;
  website: string;
  register: number;
  renew: number;
  total5: number;
  whois: string;
  ssl: string;
  notes: string;
  url: string;
  source: string;
  updatedAt: string;
}

function money(n: number) {
  return Math.round(n * 100) / 100;
}

/** Price rows for one or more extensions, cheapest 5-year cost first. */
async function pricesFor(tlds: string[]): Promise<Map<string, PriceRow[]>> {
  const admin = serviceClient();
  const [{ data: regs }, { data: rows }] = await Promise.all([
    admin.from("registrars").select("*").eq("active", true),
    admin.from("registrar_prices").select("*").in("tld", tlds),
  ]);
  const byId = new Map((regs ?? []).map((r) => [r.id, r]));
  const out = new Map<string, PriceRow[]>(tlds.map((t) => [t, []]));
  for (const p of rows ?? []) {
    const r = byId.get(p.registrar_id);
    if (!r) continue;
    const register = Number(p.register), renew = Number(p.renew);
    out.get(p.tld)!.push({
      id: r.id,
      name: r.name,
      website: r.website,
      register,
      renew,
      total5: money(register + renew * 4),
      whois: r.whois,
      ssl: r.ssl,
      notes: r.notes,
      url: "",   // filled per domain
      source: p.source,
      updatedAt: p.updated_at,
    });
  }
  for (const list of out.values()) list.sort((a, b) => a.total5 - b.total5 || a.register - b.register);
  return out;
}

function linkFor(template: string, domain: string, tld: string) {
  return template.replaceAll("{domain}", encodeURIComponent(domain)).replaceAll("{tld}", encodeURIComponent(tld));
}

/** The extension prices are kept under: "co.uk" if known, else the last label. */
function priceTld(domain: string, known: Set<string>) {
  const labels = domain.split(".");
  const two = labels.slice(-2).join(".");
  return labels.length > 2 && known.has(two) ? two : labels[labels.length - 1];
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
async function search(req: Request, body: any) {
  const domain = typeof body?.domain === "string"
    ? body.domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "")
    : "";
  if (!isValidDomain(domain)) throw new BadRequest("Enter a domain name like mystartup.com.");
  const tldLast = domain.split(".").pop()!;
  if (RESTRICTED.has(tldLast)) {
    throw new BadRequest(`.${tldLast} names are only for eligible institutions and cannot be bought from retail registrars.`);
  }

  const ip = clientIp(req);
  await rateLimit(`dsearch:${ip}`, 30, 600);
  await rateLimit(`dsearch-day:${ip}`, 300, 86400);

  const admin = serviceClient();
  const { data: knownRows } = await admin.from("registrar_prices").select("tld").like("tld", "%.%");
  const known = new Set((knownRows ?? []).map((r) => r.tld as string));
  const tld = priceTld(domain, known);

  const [availability, priceMap, { data: regs }] = await Promise.all([
    checkAvailability(domain),
    pricesFor([tld]),
    admin.from("registrars").select("id, url_template").eq("active", true),
  ]);
  const templates = new Map((regs ?? []).map((r) => [r.id, r.url_template as string]));
  const withLinks = (rows: PriceRow[], name: string, t: string) =>
    rows.map((r) => ({ ...r, url: linkFor(templates.get(r.id) ?? `https://${r.website}/`, name, t) }));

  // A taken name: offer the same name under other extensions that are free.
  let alternatives: unknown[] = [];
  if (availability.status === "registered") {
    const label = domain.slice(0, domain.length - tld.length - 1);
    const candidates = ALTERNATIVE_TLDS.filter((t) => t !== tld).map((t) => `${label}.${t}`)
      .filter((d) => isValidDomain(d));
    const altPrices = await pricesFor(candidates.map((d) => d.split(".").pop()!));
    const checked = await Promise.all(candidates.map(async (d) => ({ domain: d, ...(await checkAvailability(d)) })));
    alternatives = checked
      .filter((c) => c.status === "available" || c.status === "likely_available")
      .slice(0, MAX_ALTERNATIVES)
      .map((c) => {
        const t = c.domain.split(".").pop()!;
        const best = withLinks(altPrices.get(t) ?? [], c.domain, t)[0] ?? null;
        return {
          domain: c.domain,
          status: c.status,
          cheapest: best && { name: best.name, register: best.register, renew: best.renew, total5: best.total5, url: best.url },
        };
      });
  }

  return {
    success: true,
    domain,
    tld,
    status: availability.status,
    source: availability.source,
    registration: availability.registration,
    prices: withLinks(priceMap.get(tld) ?? [], domain, tld),
    alternatives,
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Porkbun's public price list (no key needed)
// ---------------------------------------------------------------------------

async function refreshPrices() {
  const res = await fetchWithTimeout("https://api.porkbun.com/api/json/v3/pricing/get", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }, 20000);
  if (!res.ok) throw new HttpError(502, `Porkbun answered ${res.status}.`);
  const data = await res.json();
  if (data.status !== "SUCCESS" || typeof data.pricing !== "object") throw new HttpError(502, "Porkbun's price list was not usable.");

  const admin = serviceClient();
  const { data: reg } = await admin.from("registrars").select("id").eq("id", "porkbun").maybeSingle();
  if (!reg) return { success: true, updated: 0, message: "No 'porkbun' registrar: nothing to refresh." };

  const now = new Date().toISOString();
  const rows = Object.entries(data.pricing as Record<string, { registration: string; renewal: string }>)
    .filter(([t, p]) => /^[a-z0-9-]{2,63}(\.[a-z0-9-]{2,63})?$/.test(t) &&
      Number.isFinite(Number(p.registration)) && Number.isFinite(Number(p.renewal)) &&
      Number(p.registration) < 100000 && Number(p.renewal) < 100000)
    .map(([t, p]) => ({
      tld: t,
      registrar_id: "porkbun",
      register: Number(p.registration),
      renew: Number(p.renewal),
      source: "porkbun",
      updated_at: now,
    }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("registrar_prices").upsert(rows.slice(i, i + 500), { onConflict: "tld,registrar_id" });
    if (error) throw new HttpError(500, error.message);
  }
  return { success: true, updated: rows.length };
}

// ---------------------------------------------------------------------------

function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function authorizedForRefresh(req: Request) {
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
  if (cronSecret.length >= 32 && safeEqual(req.headers.get("x-cron-secret") ?? "", cronSecret)) return true;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (serviceKey && safeEqual(req.headers.get("Authorization") ?? "", `Bearer ${serviceKey}`)) return true;
  await requireAdmin(req);   // throws for everyone else
  return true;
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json(req, { success: false, message: "POST only" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    if (body?.action === "refreshPrices") {
      await authorizedForRefresh(req);
      return json(req, await refreshPrices());
    }
    return json(req, await search(req, body));
  } catch (err) {
    if (err instanceof HttpError) return json(req, { success: false, message: err.message }, err.status);
    if (err instanceof BadRequest) return json(req, { success: false, message: err.message }, 400);
    console.error("domain-search", err);
    return json(req, { success: false, message: "The search failed. Try again." }, 500);
  }
});
