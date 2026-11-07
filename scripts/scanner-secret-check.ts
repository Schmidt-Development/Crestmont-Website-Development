// Why the Node 1 scanner is refused by staging, answered without printing a secret (SEC-003).
//
// The scanner signs with FILE_SCANNER_SECRET; the Worker verifies with its own copy. HTTP 401 "Signature mismatch"
// means the header parsed, the timestamp was inside tolerance, and the two HMACs differed — so the two copies of the
// secret differ. Nothing about the request can cause it: both sides sign exactly `${t}.${body}` and nothing else
// (scanner/src/platform.ts, verifyRunnerSignature in src/services/builds.ts).
//
// Two independent questions, because they have different answers and only one of them is authoritative:
//
//   --probe <origin>   Asks the DEPLOYED Worker. Signs a read-only /api/scan/queue request with the key a given root
//                      token derives and reports the status. 200 proves the Worker expects exactly this key; 401
//                      proves it does not. This is the oracle: it tests the running Worker, not a record of it.
//   (default)          Asks staging D1 what the deploy RECORDED. putSecretIfChanged stores a scrypt fingerprint of
//                      the value it put, salted with the root key, so a matching fingerprint says the bookkeeping
//                      agrees. It can agree while the Worker's actual value has since been changed by something
//                      else — which is why the probe exists and wins.
//   --probe-installed <origin>
//                      The same oracle for the value already in scanner.env on this host: needs no token at all.
//   --offline          Checksums only. Lets several candidate tokens be told apart with no network and no secret.
//
// It prints no secret. Checksums are a truncated SHA-256 under a fixed public label: one-way, and short enough to be
// quoted safely in a CI log or a message.
//
//   node --no-warnings scripts/scanner-secret-check.ts [--probe <origin> | --probe-installed <origin>] [--offline] [--env-file <path>]
//     env: ACCESS_ROOT_KEY (the Cloudflare API token), CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (for the D1 read)
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { deriveStagingKey, secretFingerprint } from "./staging-secrets.ts";
import { wranglerOps, annotation } from "./staging-access.ts";

/** One-way, truncated, fixed public label: safe to print and safe to quote. */
const checksum = (v: string) => createHash("sha256").update(`crestmont-checksum:v1:${v}`).digest("hex").slice(0, 12);

const SECRET_NAME = "FILE_SCANNER_SECRET";

/** The secret the installed scanner actually holds, by shape and checksum only — never its value. */
function installedSecret(file: string): { value: string; checksum: string; shape: string } | null {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  const m = /^FILE_SCANNER_SECRET=(.*)$/m.exec(text);
  if (!m) return null;
  const v = m[1].trim();
  return { value: v, checksum: checksum(v), shape: /^[0-9a-f]{64}$/.test(v) ? "64 lower-case hex (as derived)" : `UNEXPECTED SHAPE: ${v.length} character(s)` };
}

/**
 * The oracle. Signs a read-only /api/scan/queue request exactly as the scanner does and asks the deployed Worker
 * whether it accepts it. /api/scan/queue is a SELECT (scanQueue → filesAwaitingScan), so a probe changes nothing.
 */
async function probe(origin: string, secret: string): Promise<{ status: number; verdict: string }> {
  const body = JSON.stringify({ limit: 1, _nonce: randomBytes(16).toString("hex") });
  const t = Math.floor(Date.now() / 1000);
  const res = await fetch(`${origin}/api/scan/queue`, {
    method: "POST", body, signal: AbortSignal.timeout(30_000),
    headers: {
      "content-type": "application/json",
      "x-crestmont-scanner-signature": `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`,
      "user-agent": "crestmont-scanner-secret-check/1",
    },
  });
  const said = (await res.text()).slice(0, 200);
  if (res.status === 200) return { status: 200, verdict: "ACCEPTED — the deployed Worker expects exactly this key" };
  if (res.status === 401) return { status: 401, verdict: `REFUSED — the deployed Worker holds a different value (${said})` };
  if (res.status === 503) return { status: 503, verdict: `NOT CONFIGURED — the Worker has no ${SECRET_NAME} at all (${said})` };
  return { status: res.status, verdict: `UNEXPECTED HTTP ${res.status} (${said})` };
}

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const offline = args.includes("--offline");
const probeOrigin = flag("--probe");
const envFile = flag("--env-file") ?? "C:/CrestmontScanner/scanner.env";

const probeInstalled = flag("--probe-installed");

// Asking about the value already on this host needs no token and no D1: the Worker itself answers. This is the
// cheapest honest test of "is the scanner's current credential the one staging expects", and the only one that
// needs nothing the Founder has to hold.
if (probeInstalled) {
  const have = installedSecret(envFile);
  if (!have) { console.error(`::error::no FILE_SCANNER_SECRET readable at ${envFile}`); process.exit(1); }
  console.log(`installed on this host  : ${have.checksum}  (${have.shape})`);
  try {
    const p = await probe(probeInstalled, have.value);
    console.log(`\nPROBE (${probeInstalled}, installed secret): ${p.verdict}`);
    process.exitCode = p.status === 200 ? 0 : 1;
  } catch (e) {
    console.error(`::error::probe failed to reach the Worker: ${(e as Error).message}`);
    process.exitCode = 1;
  }
} else {

const root = process.env.ACCESS_ROOT_KEY ?? "";
if (!root) { console.error("::error::ACCESS_ROOT_KEY is required (the Cloudflare API token), or use --probe-installed <origin>"); process.exit(1); }
if (root !== root.trim()) console.log(`!! the token has surrounding whitespace (${root.length} characters, ${root.trim().length} trimmed) — an HMAC key is byte-exact, so this alone changes the derived secret`);

const derived = deriveStagingKey(root.trim(), "scanner");
console.log(`::add-mask::${derived}`);
console.log(`token checksum          : ${checksum(root.trim())}`);
console.log(`derives scanner key     : ${checksum(derived)}`);

const installed = installedSecret(envFile);
console.log(`installed on this host  : ${installed ? `${installed.checksum}  (${installed.shape})` : `not readable at ${envFile}`}`);
if (installed) console.log(`installed == derived    : ${installed.checksum === checksum(derived) ? "YES" : "NO — scanner.env was written from a different token"}`);

let exit = 0;

if (probeOrigin) {
  try {
    const p = await probe(probeOrigin, derived);
    console.log(`\nPROBE (${probeOrigin}): ${p.verdict}`);
    if (p.status !== 200) exit = 1;
  } catch (e) {
    console.error(`::error::probe failed to reach the Worker: ${(e as Error).message}`);
    exit = 1;
  }
}

if (!offline) {
  try {
    const fp = secretFingerprint(root.trim(), SECRET_NAME, derived);
    const rows = await wranglerOps().query<{ fingerprint: string }>(`SELECT fingerprint FROM deploy_secret_fingerprints WHERE name = '${SECRET_NAME}'`);
    if (!rows[0]) {
      console.log(`RECORDED IN D1: none — the deploy has no fingerprint for ${SECRET_NAME}, so it never put one.`);
      exit = exit || 2;
    } else {
      const ok = rows[0].fingerprint === fp;
      console.log(`RECORDED IN D1: ${ok ? "MATCH" : "MISMATCH"} — the deploy's record ${ok ? "agrees with this token" : "was written by a DIFFERENT token"}`);
      if (!ok) exit = exit || 1;
    }
  } catch (e) {
    console.error(`::error::${annotation(e)}`);
    exit = exit || 1;
  }
}

process.exitCode = exit;
}
