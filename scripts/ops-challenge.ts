// Writes a one-time operations challenge (src/services/ops-challenge.ts) as SQL for `wrangler d1 execute`, and the nonce
// that answers it to a separate file. Both files must be outside the repository checkout and must not exist yet.
//   node --no-warnings scripts/ops-challenge.ts --purpose owner_invitation --payload-email-env FOUNDER_EMAIL --out-sql <f> --out-nonce <f>
//   node --no-warnings scripts/ops-challenge.ts --purpose email_certification --run-id cert-xyz --uses 6 --out-sql <f> --out-nonce <f>
import { writeFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { OPS_CHALLENGE_PURPOSES, challengeKey, MAX_CHALLENGE_MINUTES, type OpsChallengePurpose } from "../src/services/ops-challenge.ts";

const args = process.argv.slice(2);
const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const purpose = get("--purpose") as OpsChallengePurpose;
if (!OPS_CHALLENGE_PURPOSES.includes(purpose)) { console.error(`--purpose must be one of ${OPS_CHALLENGE_PURPOSES.join(", ")}`); process.exit(2); }
const outSql = get("--out-sql"), outNonce = get("--out-nonce");
if (!outSql || !outNonce) { console.error("--out-sql and --out-nonce are required"); process.exit(2); }
const payload: Record<string, string> = {};
const emailEnv = get("--payload-email-env");
if (emailEnv) { const v = process.env[emailEnv]?.trim(); if (!v) { console.error(`${emailEnv} is empty`); process.exit(2); } payload.email = v; }
const runId = get("--run-id");
if (runId) payload.runId = runId;
const uses = Number(get("--uses") ?? 1);
if (!Number.isInteger(uses) || uses < 1 || uses > 20) { console.error("--uses must be 1-20"); process.exit(2); }
const nonce = randomBytes(32).toString("hex");
const value = JSON.stringify({ hash: createHash("sha256").update(nonce).digest("hex"), expiresAt: new Date(Date.now() + MAX_CHALLENGE_MINUTES * 60_000).toISOString(), uses, payload });
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
writeFileSync(outSql, `INSERT INTO business_settings (key, value, updated_by, updated_at) VALUES (${q(challengeKey(purpose))}, ${q(value)}, NULL, ${q(new Date().toISOString())}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = NULL, updated_at = excluded.updated_at;\n`, { flag: "wx", mode: 0o600 });
writeFileSync(outNonce, nonce, { flag: "wx", mode: 0o600 });
console.log(`Challenge for ${purpose} written (valid ${MAX_CHALLENGE_MINUTES} minutes).`);
