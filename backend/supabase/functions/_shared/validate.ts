// Input validation. The Apps Script backend wrote whatever it was handed
// straight into a spreadsheet cell; everything crossing this boundary is
// now checked and length-capped.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Labels 1-63 chars, at least one dot, TLD alphabetic. Deliberately strict:
// this value is interpolated into upstream lookup URLs.
const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.[a-z]{2,63}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function isValidDomain(value: unknown): value is string {
  return typeof value === "string" && DOMAIN_RE.test(value.trim());
}

export function isValidEmail(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Trim and hard-cap a string, rejecting non-strings. */
export function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

/** Cap the size of an incoming array payload so one request cannot be huge. */
export function boundedArray(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value)) throw new BadRequest("expected an array");
  if (value.length > max) throw new BadRequest(`too many items (max ${max})`);
  return value;
}

export class BadRequest extends Error {
  readonly status = 400;
}
