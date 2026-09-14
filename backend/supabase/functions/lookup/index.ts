// ============================================================================
// WHOIS / DNS lookup proxy
//
// The frontend currently calls networkcalc.com and dns.google straight from
// the browser. That means every visitor spends our upstream quota, the calls
// cannot be cached or rate limited, and the domain string goes out
// unvalidated. This endpoint puts all of that behind our own door.
// ============================================================================

import { json, preflight } from "../_shared/cors.ts";
import { HttpError, rateLimit, requireUser, serviceClient } from "../_shared/db.ts";
import { BadRequest, isValidDomain } from "../_shared/validate.ts";

const WHOIS_TTL_SECONDS = 6 * 60 * 60; // WHOIS changes rarely.
const DNS_TTL_SECONDS = 10 * 60;
const ALLOWED_RECORD_TYPES = new Set(["A", "AAAA", "MX", "NS", "TXT", "CNAME", "SOA", "CAA"]);

async function cached<T>(key: string, ttlSeconds: number, produce: () => Promise<T>): Promise<T> {
  const admin = serviceClient();

  const { data: hit } = await admin
    .from("lookup_cache")
    .select("payload, expires_at")
    .eq("key", key)
    .maybeSingle();

  if (hit && new Date(hit.expires_at) > new Date()) return hit.payload as T;

  const fresh = await produce();

  await admin.from("lookup_cache").upsert({
    key,
    payload: fresh,
    expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  }, { onConflict: "key" });

  return fresh;
}

async function fetchUpstream(url: string): Promise<unknown> {
  // Upstream must never be able to hang our function indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new HttpError(502, `Lookup service returned ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(504, "Lookup service did not respond in time.");
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json(req, { error: "POST only" }, 405);

  try {
    const { caller } = await requireUser(req);
    const body = await req.json().catch(() => ({}));

    const domain = typeof body?.domain === "string" ? body.domain.trim().toLowerCase() : "";
    if (!isValidDomain(domain)) throw new BadRequest("Please enter a valid domain name.");

    // Upstream quota is the scarce resource here, so the budget is per user.
    await rateLimit(`lookup:${caller.id}`, 60, 3600);

    const kind = body?.kind === "dns" ? "dns" : "whois";

    if (kind === "whois") {
      const payload = await cached(
        `whois:${domain}`,
        WHOIS_TTL_SECONDS,
        () => fetchUpstream(`https://networkcalc.com/api/dns/whois/${encodeURIComponent(domain)}`),
      );
      return json(req, { success: true, kind, domain, data: payload });
    }

    const requested: string[] = Array.isArray(body?.types) ? body.types : ["A", "MX", "NS", "TXT"];
    const types = requested
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.toUpperCase())
      .filter((t) => ALLOWED_RECORD_TYPES.has(t))
      .slice(0, 8);

    if (types.length === 0) throw new BadRequest("No valid record types requested.");

    const records: Record<string, unknown> = {};
    await Promise.all(types.map(async (type) => {
      records[type] = await cached(
        `dns:${domain}:${type}`,
        DNS_TTL_SECONDS,
        () =>
          fetchUpstream(
            `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${type}`,
          ),
      );
    }));

    return json(req, { success: true, kind, domain, data: records });
  } catch (err) {
    if (err instanceof HttpError || err instanceof BadRequest) {
      const status = err instanceof HttpError ? err.status : 400;
      return json(req, { success: false, error: err.message }, status);
    }
    console.error("lookup failed", err);
    return json(req, { success: false, error: "Lookup failed." }, 500);
  }
});
