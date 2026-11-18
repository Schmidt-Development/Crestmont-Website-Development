// Owner-approved, time-limited exceptions to the blocking dependency audit (security/audit-exceptions.json).
// Run by CI only after `npm audit --audit-level=high` has FAILED in a directory: it re-reads that directory's audit and
// passes only if every high/critical advisory there is covered by an unexpired exception for exactly that directory.
// Anything else — another advisory, the same advisory in another directory, an expired exception — fails.
//   node scripts/audit-exceptions.mjs <dir>
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The high/critical advisory ids (GHSA-…) in an `npm audit --json` report. */
export function blockingAdvisories(report) {
  const ids = new Set();
  for (const v of Object.values(report.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (typeof via !== "object" || !via) continue;
      if (via.severity !== "high" && via.severity !== "critical") continue;
      const id = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i.exec(String(via.url ?? ""))?.[0];
      ids.add(id ? id.toLowerCase() : `unidentified:${via.title ?? via.name ?? "advisory"}`);
    }
  }
  return [...ids].sort();
}

/** Which blocking advisories in `dir` are not covered by an exception valid on `today` (YYYY-MM-DD). */
export function uncovered(advisories, exceptions, dir, today) {
  const norm = (p) => p.replace(/^\.\//, "").replace(/\/+$/, "");
  const valid = exceptions.filter((e) => norm(e.path) === norm(dir) && /^\d{4}-\d{2}-\d{2}$/.test(e.expires) && today <= e.expires);
  return advisories.filter((a) => !valid.some((e) => e.advisory.toLowerCase() === a));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  const { exceptions } = JSON.parse(readFileSync(new URL("../security/audit-exceptions.json", import.meta.url), "utf8"));
  let raw;
  try { raw = execFileSync("npm", ["audit", "--json", "--omit=optional"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { raw = e.stdout; } // npm audit exits non-zero when it finds advisories
  if (!raw) { console.log(`::error::${dir}: npm audit produced no report (run from the repository root with a repo-relative directory)`); process.exit(1); }
  const advisories = blockingAdvisories(JSON.parse(raw));
  const today = new Date().toISOString().slice(0, 10);
  const left = uncovered(advisories, exceptions, dir, today);
  for (const e of exceptions.filter((x) => x.path === dir && advisories.includes(x.advisory.toLowerCase()))) {
    const days = Math.round((Date.parse(e.expires) - Date.parse(today)) / 86_400_000);
    console.log(`::warning file=security/audit-exceptions.json::${dir}: ${e.advisory} accepted until ${e.expires} (${days} day(s) left; ${e.approvedBy}). ${e.reason}`);
  }
  if (left.length) { console.log(`::error::${dir}: high/critical advisories without a valid exception: ${left.join(", ")}`); process.exit(1); }
  console.log(`${dir}: every high/critical advisory is covered by an unexpired, Owner-approved exception (${advisories.join(", ")}).`);
}
