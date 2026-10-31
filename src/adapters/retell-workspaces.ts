// Two Retell workspaces, two keys (Founder setup 2026-10-31):
//   inbound  — the AI receptionist: its call events, custom functions, inbound-call webhook, receptionist prompt sync and
//              receptionist follow-up (callback) calls. Secret RETELL_INBOUND_API_KEY.
//   outbound — the AI sales representative and the sales Self-Improvement Engine (sales optimizer). Secret
//              RETELL_OUTBOUND_API_KEY.
// Each key is the workspace's API key that carries the webhook badge: Retell signs that workspace's webhooks and custom
// function calls with it (X-Retell-Signature), and the same key authorises REST calls to that workspace's agents.
//
// Rules enforced here:
//  - The workspace of a webhook is decided ONLY by which key's HMAC verifies the raw body — never by request metadata.
//  - A route lists the workspaces it accepts; a request signed by any other workspace is refused (401).
//  - There is no fallback between workspaces, and the legacy single RETELL_API_KEY is never read.
//  - Identical inbound and outbound keys make the workspace ambiguous, so every request is refused until fixed.
import type { Env } from "../app/context.ts";
import { verifyRetellSignature, RetellAuthError } from "./retell.ts";

export type RetellWorkspace = "inbound" | "outbound";
export const RETELL_KEY_NAMES = { inbound: "RETELL_INBOUND_API_KEY", outbound: "RETELL_OUTBOUND_API_KEY" } as const satisfies Record<RetellWorkspace, keyof Env>;
/** Read by nothing; reported on /staff/integrations if it is still set, because it would be ambiguous. */
export const LEGACY_RETELL_KEY_NAME = "RETELL_API_KEY";

type KeyEnv = Partial<Pick<Env, "RETELL_INBOUND_API_KEY" | "RETELL_OUTBOUND_API_KEY">>;

/** The key for exactly one workspace, or undefined. Never another workspace's key. */
export function retellKey(env: KeyEnv, ws: RetellWorkspace): string | undefined {
  const v = env[RETELL_KEY_NAMES[ws]];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export const keysAmbiguous = (env: KeyEnv): boolean => {
  const i = retellKey(env, "inbound"), o = retellKey(env, "outbound");
  return !!i && i === o;
};

/**
 * Verifies X-Retell-Signature against the keys of the allowed workspaces and returns the workspace whose key produced
 * it. Fails closed with a diagnostic naming the missing secret(s) when none of the allowed keys is configured.
 */
export async function verifyRetellWorkspace(env: KeyEnv, allowed: readonly RetellWorkspace[], rawBody: string, header: string | null, nowMs = Date.now()): Promise<RetellWorkspace> {
  if (keysAmbiguous(env)) throw new RetellAuthError("Retell keys misconfigured: RETELL_INBOUND_API_KEY and RETELL_OUTBOUND_API_KEY are identical, so the workspace cannot be determined");
  const configured = allowed.filter((ws) => retellKey(env, ws));
  if (!configured.length) throw new RetellAuthError(`Retell webhook key not configured (${allowed.map((ws) => RETELL_KEY_NAMES[ws]).join(" or ")})`);
  let last: unknown = null;
  for (const ws of configured) {
    try { await verifyRetellSignature(retellKey(env, ws), rawBody, header, nowMs); return ws; }
    catch (e) { last = e; }
  }
  if (last instanceof RetellAuthError && /malformed|tolerance/.test(last.message)) throw last;
  throw new RetellAuthError(configured.length === allowed.length ? "Signature mismatch" : `Signature mismatch (${allowed.filter((ws) => !configured.includes(ws)).map((ws) => RETELL_KEY_NAMES[ws]).join(", ")} not configured)`);
}
