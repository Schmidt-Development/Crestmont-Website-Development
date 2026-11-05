// SEC-03: the malware scanner's own endpoints, with their own credential.
//
// recordScanResult and filesAwaitingScan in src/services/malware-scan.ts were complete and tested and
// reachable from nothing, so a scanner installed on Node 1 could not pull work or report a verdict. These
// three routes are that transport.
//
// They were first written on the build runner's surface, signed with BUILD_RUNNER_SECRET, because Node 1
// already holds it. The production-preparation session pointed out what that costs, and it is more than
// convenience is worth:
//
//   · BUILD_RUNNER_SECRET claims build jobs, fetches checkpoints, stores revisions and deploys previews. A
//     file scanner has no business holding any of that (SEC-05, least privilege).
//   · Phase 1 keeps the AI builder off on production, and the production deploy preflight REFUSES a deploy
//     while BUILD_RUNNER_SECRET is on the production Worker. A shared secret therefore meant production
//     could never receive a malware verdict and F-02 could never close for production.
//
// So the scanner gets FILE_SCANNER_SECRET and its own path, independent of the builder's lifecycle. Unset
// means these endpoints refuse: no scanner can report, files stay 'pending', and nothing is ever labelled
// clean without a verdict.
import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { HttpError, jsonResponse } from "../app/http.ts";
import { verifyRunnerSignature, RunnerAuthError } from "../services/builds.ts";
import { claimSignatureOnce } from "../services/security.ts";
import { securityEvent } from "../services/security.ts";
import * as MS from "../services/malware-scan.ts";

const SCAN = "/api/scan";

/** Verifies the scanner's signature and returns the parsed body. Same HMAC scheme as the runner's. */
async function scannerBody(ctx: AppContext): Promise<Record<string, unknown>> {
  const raw = await ctx.req.text();
  if (raw.length > 1_000_000) throw new HttpError(413, "Request too large");
  try {
    await verifyRunnerSignature(ctx.env.FILE_SCANNER_SECRET, raw, ctx.req.headers.get("x-crestmont-scanner-signature"));
  } catch (e) {
    // A scanner that is running but cannot authenticate would otherwise be invisible. Recorded at most once
    // a minute, reason only — never the header or the body. Only well-formed signatures, so an unsigned
    // internet scanner cannot take the slot.
    if (e instanceof RunnerAuthError && !/Missing or malformed/.test(e.message)) {
      const recent = await ctx.db.prepare(`SELECT 1 FROM security_events WHERE kind = 'scanner_auth_failed' AND created_at > ?`)
        .bind(new Date(ctx.now().getTime() - 60_000).toISOString()).first();
      if (!recent) await securityEvent(ctx.db, "scanner_auth_failed", { ip: ctx.ip, detail: `${e.message} on ${ctx.url.pathname}` });
    }
    throw e;
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new HttpError(400, "Malformed JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Body must be a JSON object");
  const nonce = (body as Record<string, unknown>)._nonce;
  if (typeof nonce === "string" && /^[0-9a-f]{32,64}$/.test(nonce)) {
    if (!(await claimSignatureOnce(ctx.db, `scanner:${nonce}`))) throw new HttpError(409, "Replayed request");
  }
  return body as Record<string, unknown>;
}

/**
 * Answered before the signature is checked, because there is nothing to check against. A thrown
 * HttpError(503) would surface as an opaque 500 — app.ts returns a message only for 4xx — and a machine
 * client deserves to be told what is missing rather than left to guess at a server error.
 */
function notConfigured(ctx: AppContext): Response | null {
  if (ctx.env.FILE_SCANNER_SECRET) return null;
  return jsonResponse(ctx, 503, { code: "not_configured", error: "No malware scanner is configured (FILE_SCANNER_SECRET is not set). Files stay pending and are never labelled clean without a verdict." });
}

export function register(r: Router): void {
  r.post(`${SCAN}/queue`, async (ctx) => {
    const off = notConfigured(ctx); if (off) return off;
    const b = await scannerBody(ctx);
    return jsonResponse(ctx, 200, await MS.scanQueue(ctx.db, Number(b.limit ?? 25)));
  });
  r.post(`${SCAN}/file`, async (ctx) => {
    const off = notConfigured(ctx); if (off) return off;
    return jsonResponse(ctx, 200, await MS.scanFileBytes(ctx.db, ctx.storage, await scannerBody(ctx)));
  });
  r.post(`${SCAN}/result`, async (ctx) => {
    const off = notConfigured(ctx); if (off) return off;
    const b = await scannerBody(ctx);
    return jsonResponse(ctx, 200, await MS.recordScanResult(ctx.db, {
      fileId: String(b.fileId ?? ""), verdict: b.verdict as MS.ScanVerdict, engine: String(b.engine ?? ""),
      scannedSha256: String(b.scannedSha256 ?? ""), signature: typeof b.signature === "string" ? b.signature : null,
      detail: typeof b.detail === "string" ? b.detail : null, scannedAt: typeof b.scannedAt === "string" ? b.scannedAt : undefined,
    }));
  });
}
