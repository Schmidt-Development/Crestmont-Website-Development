// Resolves the EVIDENCE_INGEST_SECRET a workflow uses to sign requests to the staging readiness system
// (INFRA-005, LAUNCH-002). The staging Worker, ci.yml, release.yml and deploy-production.yml must all hold
// the SAME value, otherwise the signed release-authorization check returns 401 and production can never be
// released. A secret must also not change from one deploy to the next: Cloudflare refuses a rollback to a
// version whose secrets have since changed (error 10220, see scripts/staging-secrets.ts). So:
//
//   • stable  — EVIDENCE_INGEST_SECRET_STABLE is set (from the GitHub secret EVIDENCE_INGEST_SECRET): that exact
//               value is used, every run. This is the only mode in which CI, releases and production release
//               authorization can sign against staging.
//   • derived — the GitHub secret is not configured yet: the stable key derived from the Cloudflare token
//               (scripts/staging-secrets.ts `derive evidence`) is used, with a warning that GitHub-side signing
//               cannot work until the GitHub secret exists.
//   • a configured value that is too short or malformed is refused (exit 1); it is never replaced silently.
//   No mode generates a random value: nothing is rotated per run.
//
// Usage (GitHub Actions):
//   EVIDENCE_INGEST_SECRET_STABLE=${{ secrets.EVIDENCE_INGEST_SECRET }} ACCESS_ROOT_KEY=${{ secrets.CLOUDFLARE_API_TOKEN }} \
//     node --no-warnings scripts/evidence-secret.ts resolve
//     → writes EVIDENCE_INGEST_SECRET to $GITHUB_ENV and mode=stable|derived, fingerprint=<12 hex> to $GITHUB_OUTPUT
//   EVIDENCE_INGEST_SECRET=… node --no-warnings scripts/evidence-secret.ts fingerprint
//     → prints the fingerprint only
//
// The value itself is only ever emitted inside an ::add-mask:: command and the GITHUB_ENV file. The
// fingerprint (first 12 hex of SHA-256) lets the Founder compare environments without revealing anything.
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { deriveStagingKey } from "./staging-secrets.ts";

export const MIN_SECRET_LENGTH = 32;

export function fingerprint(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 12);
}

export type Resolution = { mode: "stable" | "derived"; secret: string; fingerprint: string };

export function resolveEvidenceSecret(stable: string | undefined, accessRootKey: string | undefined): Resolution {
  const s = (stable ?? "").trim();
  if (s) {
    if (s.length < MIN_SECRET_LENGTH) throw new Error(`The GitHub secret EVIDENCE_INGEST_SECRET is set but shorter than ${MIN_SECRET_LENGTH} characters. Replace it with \`openssl rand -hex 32\`; it is not replaced automatically.`);
    if (/\s/.test(s)) throw new Error("The GitHub secret EVIDENCE_INGEST_SECRET contains whitespace. Re-enter it as a single line.");
    return { mode: "stable", secret: s, fingerprint: fingerprint(s) };
  }
  if (!accessRootKey) throw new Error("Neither the GitHub secret EVIDENCE_INGEST_SECRET nor the Cloudflare token (ACCESS_ROOT_KEY) is available; refusing to invent an evidence secret.");
  const d = deriveStagingKey(accessRootKey, "evidence");
  return { mode: "derived", secret: d, fingerprint: fingerprint(d) };
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("scripts/evidence-secret.ts");
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === "fingerprint") {
    const v = process.env.EVIDENCE_INGEST_SECRET;
    if (!v) { console.error("EVIDENCE_INGEST_SECRET is not set."); process.exit(2); }
    console.log(fingerprint(v));
  } else if (cmd === "print") {
    // For command substitution only (v=$(… print)): the value goes to stdout and nowhere else; the caller masks it.
    // The mode and any warning go to stderr so they are never captured into the variable.
    let r: Resolution;
    try { r = resolveEvidenceSecret(process.env.EVIDENCE_INGEST_SECRET_STABLE, process.env.ACCESS_ROOT_KEY); }
    catch (e) { console.error(`::error title=EVIDENCE_INGEST_SECRET invalid::${(e as Error).message}`); process.exit(1); }
    if (r.mode === "derived") console.error(`::warning title=EVIDENCE_INGEST_SECRET not configured::Using the staging key derived from the Cloudflare token (fingerprint ${r.fingerprint}); CI, releases and production release authorization cannot sign against staging until the repository secret EVIDENCE_INGEST_SECRET is set.`);
    else console.error(`Evidence secret: stable (GitHub secret EVIDENCE_INGEST_SECRET), fingerprint ${r.fingerprint}.`);
    process.stdout.write(r.secret);
  } else if (cmd === "resolve") {
    let r: Resolution;
    try { r = resolveEvidenceSecret(process.env.EVIDENCE_INGEST_SECRET_STABLE, process.env.ACCESS_ROOT_KEY); }
    catch (e) { console.log(`::error title=EVIDENCE_INGEST_SECRET invalid::${(e as Error).message}`); process.exit(1); }
    console.log(`::add-mask::${r.secret}`);
    const envFile = process.env.GITHUB_ENV, outFile = process.env.GITHUB_OUTPUT;
    if (!envFile || !outFile) { console.error("GITHUB_ENV and GITHUB_OUTPUT must be set (this runs inside GitHub Actions)."); process.exit(2); }
    appendFileSync(envFile, `EVIDENCE_INGEST_SECRET=${r.secret}\n`);
    appendFileSync(outFile, `mode=${r.mode}\nfingerprint=${r.fingerprint}\n`);
    if (r.mode === "stable") console.log(`Evidence secret: stable (GitHub secret EVIDENCE_INGEST_SECRET), fingerprint ${r.fingerprint}.`);
    else console.log(`::warning title=EVIDENCE_INGEST_SECRET not configured::Using the staging key derived from the Cloudflare token (fingerprint ${r.fingerprint}). CI evidence, release candidates and production release authorization cannot sign against staging until the repository secret EVIDENCE_INGEST_SECRET is set (docs/DEPLOYMENT.md §5).`);
  } else {
    console.error("Usage: evidence-secret.ts resolve | print | fingerprint");
    process.exit(2);
  }
}
