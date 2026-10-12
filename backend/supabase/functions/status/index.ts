// ============================================================================
// Service status, for the public status page
//
//   GET  (or POST without an action)  the page's data: current state, and
//        per part 90 daily blocks and the uptime over them. Public, cached
//        for a minute.
//   POST { action: "probe" }  check every part once and record it
//        (pg_cron every 5 minutes, with the cron secret).
//
// Each probe is a real request a user's browser or our own jobs would make;
// a part is down when that request fails or is too slow.
// ============================================================================

import { json, preflight } from "../_shared/cors.ts";
import { clientIp, HttpError, rateLimit, serviceClient } from "../_shared/db.ts";

const DAYS = 90;
const SLOW_MS = 10000;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SITE_URL = (Deno.env.get("STATUS_WEBSITE_URL") ?? Deno.env.get("SITE_URL") ?? "").replace(/\/+$/, "");
const APP_URL = (Deno.env.get("STATUS_APP_URL") ?? "https://app.getdomainvault.com").replace(/\/+$/, "");

/** The parts, in page order. Names are what the page shows. */
const COMPONENTS = [
  { key: "app", name: "Dashboard App" },
  { key: "website", name: "Website" },
  { key: "api", name: "Domain API" },
  { key: "lookups", name: "Domain Lookup (RDAP)" },
  { key: "dns", name: "DNS Verification" },
  { key: "reminders", name: "Reminder Automations" },
  { key: "email", name: "Email Delivery" },
] as const;
type Key = typeof COMPONENTS[number]["key"];

interface Probe {
  ok: boolean;
  latency_ms: number;
  detail: string | null;
}

async function timed(run: (signal: AbortSignal) => Promise<string | null>): Promise<Probe> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SLOW_MS);
  try {
    const problem = await run(controller.signal);
    return { ok: problem === null, latency_ms: Date.now() - started, detail: problem };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - started,
      detail: controller.signal.aborted ? `no answer in ${SLOW_MS / 1000} s` : String(err).slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
}

const expectStatus = (url: string, wanted: (s: number) => boolean, init: RequestInit = {}) =>
  timed(async (signal) => {
    const res = await fetch(url, { ...init, signal, redirect: "follow" });
    await res.body?.cancel();
    return wanted(res.status) ? null : `HTTP ${res.status}`;
  });

async function remindersHealthy(): Promise<Probe> {
  return timed(async () => {
    const admin = serviceClient();
    const [{ data: jobs }, { data: beat }] = await Promise.all([
      admin.rpc("status_job_health"),
      admin.from("lookup_cache").select("payload").eq("key", "heartbeat:reminders").maybeSingle(),
    ]);
    // deno-lint-ignore no-explicit-any
    const job = (jobs ?? []).find((j: any) => j.jobname === "domain-vault-reminders");
    if (job) {
      const age = job.last_run ? Date.now() - new Date(job.last_run).getTime() : Infinity;
      if (age > 26 * 3600 * 1000) return "the daily run did not happen";
      if (job.last_status && job.last_status !== "succeeded") return `last run: ${job.last_status}`;
    }
    // deno-lint-ignore no-explicit-any
    const last = beat?.payload as any;
    if (last && last.ok === false) return "the last sweep reported an error";
    return null;
  });
}

async function emailHealthy(): Promise<Probe> {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return { ok: true, latency_ms: 0, detail: "not configured here" };
  return timed(async (signal) => {
    const res = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${key}` }, signal });
    if (!res.ok) return `Resend answered ${res.status}`;
    const data = await res.json();
    // deno-lint-ignore no-explicit-any
    const sending = (data.data ?? []).some((d: any) => d.status === "verified" && d.capabilities?.sending === "enabled");
    return sending ? null : "no verified sending domain";
  });
}

async function probeAll() {
  const results: Record<Key, Probe> = {
    app: await expectStatus(`${APP_URL}/`, (s) => s === 200),
    website: await expectStatus(`${SITE_URL}/`, (s) => s === 200),
    api: await expectStatus(`${SUPABASE_URL}/functions/v1/api`, (s) => s === 200, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "getPrices" }),
    }),
    lookups: await expectStatus("https://rdap.verisign.com/com/v1/domain/example.com", (s) => s === 200, {
      headers: { accept: "application/rdap+json" },
    }),
    dns: await expectStatus("https://cloudflare-dns.com/dns-query?name=example.com&type=A", (s) => s === 200, {
      headers: { accept: "application/dns-json" },
    }),
    reminders: await remindersHealthy(),
    email: await emailHealthy(),
  };
  const admin = serviceClient();
  const { error } = await admin.from("status_checks").insert(
    COMPONENTS.map((c) => ({ component: c.key, ...results[c.key] })),
  );
  if (error) throw new HttpError(500, error.message);
  // Keep a little more than the page shows.
  await admin.from("status_checks").delete().lt("checked_at", new Date(Date.now() - (DAYS + 5) * 86400000).toISOString());
  await admin.from("lookup_cache").delete().eq("key", "status:page");
  return { success: true, results };
}

// ---------------------------------------------------------------------------

function utcDay(offset: number) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

async function pageData() {
  const admin = serviceClient();
  const { data: hit } = await admin.from("lookup_cache").select("payload, expires_at").eq("key", "status:page").maybeSingle();
  if (hit && new Date(hit.expires_at) > new Date()) return hit.payload;

  const [{ data: daily, error }, { data: latest }] = await Promise.all([
    admin.rpc("status_daily", { p_days: DAYS }),
    admin.from("status_checks").select("component, ok, checked_at, detail")
      .gte("checked_at", new Date(Date.now() - 20 * 60000).toISOString())
      .order("checked_at", { ascending: false }),
  ]);
  if (error) throw new HttpError(500, error.message);

  const days = Array.from({ length: DAYS }, (_, i) => utcDay(DAYS - 1 - i));   // oldest first
  const components = COMPONENTS.map((c) => {
    // deno-lint-ignore no-explicit-any
    const byDay = new Map((daily ?? []).filter((d: any) => d.component === c.key).map((d: any) => [String(d.day), d]));
    let total = 0, ok = 0;
    const blocks = days.map((day) => {
      // deno-lint-ignore no-explicit-any
      const d = byDay.get(day) as any;
      if (!d) return 0;   // no data that day
      total += d.total;
      ok += d.ok;
      const failed = d.total - d.ok;
      return failed === 0 ? 1 : failed / d.total <= 0.1 ? 2 : 3;
    });
    const now = (latest ?? []).find((l) => l.component === c.key);
    return {
      key: c.key,
      name: c.name,
      // null: nothing measured yet
      uptime: total ? `${(Math.floor((ok / total) * 10000) / 100).toFixed(2).replace(/\.?0+$/, "")}%` : null,
      current: now ? (now.ok ? "operational" : "down") : "unknown",
      blocks,
    };
  });

  const down = components.filter((c) => c.current === "down");
  const overall = down.length === 0
    ? { status: "operational", title: "We're fully operational", description: "We're not aware of any issues affecting our systems." }
    : down.length >= 3
    ? { status: "outage", title: "Major outage", description: `Affected: ${down.map((c) => c.name).join(", ")}. We are working on it.` }
    : { status: "degraded", title: "Some systems are affected", description: `Affected: ${down.map((c) => c.name).join(", ")}. Everything else is working.` };

  const fmt = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const payload = {
    success: true,
    overall,
    downComponents: down.map((c) => c.key),
    dateRange: `${fmt(days[0])} - ${fmt(days[days.length - 1])}`,
    days: { from: days[0], to: days[days.length - 1] },
    components,
    updatedAt: new Date().toISOString(),
  };
  await admin.from("lookup_cache").upsert({
    key: "status:page",
    payload,
    expires_at: new Date(Date.now() + 60000).toISOString(),
  }, { onConflict: "key" });
  return payload;
}

function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function cronAuthorized(req: Request) {
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
  if (cronSecret.length >= 32 && safeEqual(req.headers.get("x-cron-secret") ?? "", cronSecret)) return true;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return serviceKey.length > 0 && safeEqual(req.headers.get("Authorization") ?? "", `Bearer ${serviceKey}`);
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (body?.action === "probe") {
        if (!cronAuthorized(req)) return json(req, { success: false, message: "forbidden" }, 403);
        return json(req, await probeAll());
      }
    } else if (req.method !== "GET") {
      return json(req, { success: false, message: "GET or POST" }, 405);
    }
    await rateLimit(`status:${clientIp(req)}`, 120, 600);
    return json(req, await pageData());
  } catch (err) {
    if (err instanceof HttpError) return json(req, { success: false, message: err.message }, err.status);
    console.error("status", err);
    return json(req, { success: false, message: "Status unavailable." }, 500);
  }
});
