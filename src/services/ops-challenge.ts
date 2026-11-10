// One-time operations challenges (Founder, 2026-11-09). Production's EVIDENCE_INGEST_SECRET is a production-only random
// value that no workflow knows (provision-production.yml), so signed ops requests cannot reach the production Worker.
// Instead, a workflow that already holds the production Cloudflare token — the same authority that deploys and migrates
// production — writes a challenge into the production database with `wrangler d1 execute`: the SHA-256 of a random
// nonce, a purpose, an expiry (at most 15 minutes) and a small payload. The Worker accepts the nonce once, for that
// purpose only, and deletes the row atomically. No secret is created, rotated or printed.
//
// Stored in business_settings under ops.challenge.<purpose> (no migration). Written by scripts/ops-challenge.ts.
import type { AppContext } from "../app/context.ts";
import { hashToken } from "../lib/auth-crypto.ts";

export const OPS_CHALLENGE_PURPOSES = ["owner_invitation", "email_certification", "integration_probe"] as const;
export type OpsChallengePurpose = (typeof OPS_CHALLENGE_PURPOSES)[number];
export const challengeKey = (purpose: OpsChallengePurpose) => `ops.challenge.${purpose}`;
export const MAX_CHALLENGE_MINUTES = 15;

/** The payload when `nonce` answers a live challenge for `purpose` (consumed); otherwise null. */
export async function consumeOpsChallenge(ctx: Pick<AppContext, "db" | "now">, purpose: OpsChallengePurpose, nonce: unknown): Promise<Record<string, unknown> | null> {
  if (typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce)) return null;
  const key = challengeKey(purpose);
  const row = await ctx.db.prepare(`SELECT value FROM business_settings WHERE key = ?`).bind(key).first<{ value: string }>().catch(() => null);
  if (!row) return null;
  let c: { hash?: string; expiresAt?: string; uses?: number; payload?: Record<string, unknown> };
  try { c = JSON.parse(row.value); } catch { return null; }
  const expires = Date.parse(c.expiresAt ?? "");
  const now = ctx.now().getTime();
  if (!c.hash || !Number.isFinite(expires) || expires < now || expires > now + MAX_CHALLENGE_MINUTES * 60_000 + 60_000) {
    await ctx.db.prepare(`DELETE FROM business_settings WHERE key = ? AND value = ?`).bind(key, row.value).run();
    return null;
  }
  if (!timingSafeEqual(await hashToken(nonce), c.hash)) return null;
  // Each use consumes one of the challenge's uses (default 1; an email certification run needs one per part). Compare-
  // and-swap on the exact stored value: of two concurrent requests only one proceeds.
  const uses = Number.isInteger(c.uses) && (c.uses as number) > 0 ? (c.uses as number) : 1;
  const done = uses <= 1
    ? await ctx.db.prepare(`DELETE FROM business_settings WHERE key = ? AND value = ?`).bind(key, row.value).run()
    : await ctx.db.prepare(`UPDATE business_settings SET value = ? WHERE key = ? AND value = ?`).bind(JSON.stringify({ ...c, uses: uses - 1 }), key, row.value).run();
  if (done.meta.changes !== 1) return null;
  return c.payload ?? {};
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
