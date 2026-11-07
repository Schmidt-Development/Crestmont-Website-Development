// Why the Node 1 scanner is refused by staging, answered without printing a secret (SEC-003).
//
// The scanner signs with FILE_SCANNER_SECRET; the Worker verifies with its own copy. HTTP 401 "Signature mismatch"
// means the header parsed, the timestamp was inside tolerance, and the two HMACs differed — so the two copies of the
// secret differ. Nothing about the request can cause it: both sides sign exactly `${t}.${body}` and nothing else
// (scanner/src/platform.ts, verifyRunnerSignature in src/services/builds.ts).
//
// Staging's copy is derived from the CLOUDFLARE_API_TOKEN secret of the environment the deploy ran in, so a DIFFERENT
// Cloudflare token derives a different scanner key. This compares the key a given token derives against the
// fingerprint the deploy recorded in staging D1 (deploy_secret_fingerprints, written by putSecretIfChanged) and says
// MATCH or MISMATCH. The fingerprint is scrypt-salted with the root key, so the comparison proves the token without
// revealing anything about it.
//
// It prints no secret. Checksums are a truncated SHA-256 under a fixed public label: one-way, and short enough to be
// quoted safely, so several candidate tokens can be told apart (--offline) without any of them being disclosed.
//
//   node --no-warnings scripts/scanner-secret-check.ts [--offline] [--env-file <path>]
//     env: ACCESS_ROOT_KEY (the Cloudflare API token), CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (for the D1 read)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { deriveStagingKey, secretFingerprint } from "./staging-secrets.ts";
import { wranglerOps, annotation } from "./staging-access.ts";

/** One-way, truncated, fixed public label: safe to print and safe to quote. */
const checksum = (v: string) => createHash("sha256").update(`crestmont-checksum:v1:${v}`).digest("hex").slice(0, 12);

const SECRET_NAME = "FILE_SCANNER_SECRET";

/** The secret the installed scanner actually holds, by shape and checksum only — never its value. */
function installedSecret(file: string): { checksum: string; shape: string } | null {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  const m = /^FILE_SCANNER_SECRET=(.*)$/m.exec(text);
  if (!m) return null;
  const v = m[1].trim();
  return { checksum: checksum(v), shape: /^[0-9a-f]{64}$/.test(v) ? "64 lower-case hex (as derived)" : `UNEXPECTED SHAPE: ${v.length} character(s)` };
}

const args = process.argv.slice(2);
const offline = args.includes("--offline");
const envFile = args[args.indexOf("--env-file") + 1] && args.includes("--env-file") ? args[args.indexOf("--env-file") + 1] : "C:/CrestmontScanner/scanner.env";

const root = process.env.ACCESS_ROOT_KEY ?? "";
if (!root) { console.error("::error::ACCESS_ROOT_KEY is required (the Cloudflare API token)"); process.exit(1); }
if (root !== root.trim()) console.log(`!! the token has surrounding whitespace (${root.length} characters, ${root.trim().length} trimmed) — an HMAC key is byte-exact, so this alone changes the derived secret`);

const derived = deriveStagingKey(root.trim(), "scanner");
console.log(`token checksum          : ${checksum(root.trim())}`);
console.log(`derives scanner key     : ${checksum(derived)}`);

const installed = installedSecret(envFile);
console.log(`installed on this host  : ${installed ? `${installed.checksum}  (${installed.shape})` : `not readable at ${envFile}`}`);
if (installed) console.log(`installed == derived    : ${installed.checksum === checksum(derived) ? "YES" : "NO — scanner.env was written from a different token"}`);

if (offline) process.exit(0);

try {
  const fp = secretFingerprint(root.trim(), SECRET_NAME, derived);
  const rows = await wranglerOps().query<{ fingerprint: string }>(`SELECT fingerprint FROM deploy_secret_fingerprints WHERE name = '${SECRET_NAME}'`);
  if (!rows[0]) {
    console.log(`\nVERDICT: UNDETERMINED — staging D1 has no recorded fingerprint for ${SECRET_NAME}, so the deploy never put it. Nothing here proves or disproves the token.`);
    process.exit(2);
  }
  const ok = rows[0].fingerprint === fp;
  console.log(`\nVERDICT: ${ok ? "MATCH" : "MISMATCH"} — this token ${ok ? "derives exactly the secret staging was given" : "does NOT derive the secret staging was given; the deploy used a different Cloudflare token"}`);
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error(`::error::${annotation(e)}`);
  process.exit(1);
}
