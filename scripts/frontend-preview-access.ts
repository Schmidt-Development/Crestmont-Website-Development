// Frontend preview only (deploy-frontend-preview.yml). Replaces the randomly generated demo-account credentials
// from scripts/seed-staging.ts with Founder-controlled access, so no credential ever has to leave the runner:
//   • every demo account (@crestmont-preview.test) gets the password in FRONTEND_PREVIEW_DEMO_PASSWORD
//     (the Founder's own secret — the Founder already knows it);
//   • staff accounts (Owner included) have NO authenticator enrolled: two-factor stays REQUIRED, and the first
//     sign-in is sent to /mfa/setup, where the Founder enrols their own authenticator app. No TOTP key is created
//     here, printed, stored in an artifact, or known to anyone but the person who enrols.
// Output: SQL for `wrangler d1 execute` against the disposable preview database only. Never run against staging
// or production (the workflow guard pins the target to crestmont-frontend-preview).
// Usage: FRONTEND_PREVIEW_DEMO_PASSWORD=… node --no-warnings scripts/frontend-preview-access.ts --out access.sql
import { writeFileSync } from "node:fs";
import { hashPassword } from "../src/lib/auth-crypto.ts";

const args = process.argv.slice(2);
const out = args[args.indexOf("--out") + 1];
const pw = process.env.FRONTEND_PREVIEW_DEMO_PASSWORD ?? "";
if (!out || args.indexOf("--out") < 0) throw new Error("--out <file.sql> is required");
if (pw.length < 12) throw new Error("FRONTEND_PREVIEW_DEMO_PASSWORD must be at least 12 characters");

// One hash per run (salted); the same value is applied to every demo account.
const hash = (await hashPassword(pw)).replace(/'/g, "''");
writeFileSync(out, [
  `UPDATE users SET password_hash = '${hash}' WHERE email LIKE '%@crestmont-preview.test';`,
  `UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_last_step = NULL, mfa_enabled = 0 WHERE email LIKE '%@crestmont-preview.test';`,
  "",
].join("\n"));
console.log("Demo-account access SQL written (no credentials printed).");
