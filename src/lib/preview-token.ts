// Private AI-builder previews (Founder decision D3, 2026-10-28): sign-in links for the preview gate.
//
// Every preview Worker is deployed by the build runner behind a gate (runner/src/preview-gate.ts) that serves
// nothing (pages, assets or /api/*) without a session cookie. The only way to get that cookie is a short-lived
// link signed here, after the platform has checked who is asking: an owner/staff member with builds.read, or a
// signed-in member of the project's own customer organization for a preview the owner shared with them.
//
// Keys: each preview has its own key, HMAC-SHA256(PREVIEW_GATE_SECRET, "crestmont-preview-key:" + workerName),
// deployed to that Worker only. The master secret stays on the platform and the runner; a leaked preview key opens
// that one preview, never another customer's. Format and derivation are mirrored in the runner's gate (tested
// against each other in runner/test/preview-gate.test.ts).

const enc = new TextEncoder();

export const PREVIEW_LINK_TTL_SECONDS = 300;
export const PREVIEW_GATE_PATH = "/__crestmont/auth";

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(key: string, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

/** The key one preview Worker verifies with (derived; the master secret never leaves the platform and runner). */
export async function previewKey(masterSecret: string, workerName: string): Promise<string> {
  if (!masterSecret || masterSecret.length < 32) throw new Error("PREVIEW_GATE_SECRET must be at least 32 characters");
  return b64url(await hmac(masterSecret, `crestmont-preview-key:${workerName}`));
}

/** A relative path on the preview (never another origin). */
export function safePreviewPath(p: string | null | undefined): string {
  const v = (p ?? "/").trim();
  return /^\/(?![/\\])[^\s]*$/.test(v) && v.length <= 512 ? v : "/";
}

/**
 * Sign-in link for one preview: `<origin>/__crestmont/auth?t=<payload>.<sig>`, valid for 5 minutes. The gate
 * exchanges it for a 2-hour, host-only session cookie and redirects to `next`, so the token leaves the address bar.
 */
export async function previewSignInUrl(masterSecret: string, workerName: string, previewUrl: string, opts: { next?: string; now?: Date; ttlSeconds?: number; audience: "owner" | "customer" }): Promise<string> {
  const origin = new URL(previewUrl).origin;
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const payload = b64url(enc.encode(JSON.stringify({ p: workerName, exp: now + (opts.ttlSeconds ?? PREVIEW_LINK_TTL_SECONDS), n: safePreviewPath(opts.next), a: opts.audience })));
  const sig = b64url(await hmac(await previewKey(masterSecret, workerName), `link.${payload}`));
  return `${origin}${PREVIEW_GATE_PATH}?t=${payload}.${sig}`;
}
