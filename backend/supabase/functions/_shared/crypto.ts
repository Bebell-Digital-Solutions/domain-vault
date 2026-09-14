// AES-256-GCM for registrar credentials.
//
// The key lives only in the Edge Function environment. It is never written to
// the database and never sent to the browser, so a leaked database dump
// yields ciphertext and nothing else.
//
// Generate one with:  openssl rand -base64 32
//
// KEY ROTATION: bump CREDENTIAL_KEY_VERSION and keep the previous key in
// CREDENTIAL_ENCRYPTION_KEY_PREVIOUS. decrypt() tries the current key first
// and falls back, so old rows keep working until they are re-saved.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const KEY_VERSION = Number(Deno.env.get("CREDENTIAL_KEY_VERSION") ?? "1");

function b64encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function b64decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

async function importKey(raw: string | undefined): Promise<CryptoKey | null> {
  if (!raw) return null;
  const bytes = b64decode(raw);
  if (bytes.length !== 32) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be exactly 32 bytes (openssl rand -base64 32)");
  }
  return await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

let currentKey: Promise<CryptoKey | null> | null = null;
let previousKey: Promise<CryptoKey | null> | null = null;

function keys() {
  currentKey ??= importKey(Deno.env.get("CREDENTIAL_ENCRYPTION_KEY"));
  previousKey ??= importKey(Deno.env.get("CREDENTIAL_ENCRYPTION_KEY_PREVIOUS"));
  return { currentKey, previousKey };
}

export async function encryptSecret(plaintext: string): Promise<{ ciphertext: string; iv: string }> {
  const key = await keys().currentKey;
  if (!key) throw new Error("CREDENTIAL_ENCRYPTION_KEY is not configured");

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext),
  );

  return { ciphertext: b64encode(new Uint8Array(encrypted)), iv: b64encode(iv) };
}

export async function decryptSecret(ciphertext: string, iv: string): Promise<string> {
  const ivBytes = b64decode(iv);
  const data = b64decode(ciphertext);
  const { currentKey: cur, previousKey: prev } = keys();

  for (const candidate of [await cur, await prev]) {
    if (!candidate) continue;
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBytes }, candidate, data);
      return decoder.decode(plain);
    } catch {
      // Wrong key, or tampered ciphertext — GCM authentication failed. Try next.
    }
  }
  throw new Error("unable to decrypt credential with any configured key");
}
