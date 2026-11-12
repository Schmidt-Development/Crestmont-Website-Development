// Workflow security invariants (security remediation 2026-10-28: F-18, F-19, F-23, F-24; ported from PR #8 onto the
// consolidated remediation, PR #20). Line-based parsing of the
// workflow files (the platform has no YAML dependency); each check names the file and step it found.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const DIR = ".github/workflows";
const files = readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
const read = (f: string) => readFileSync(`${DIR}/${f}`, "utf8");

interface Step { name: string; text: string; env: string; run: string }
/** Steps of every job: a step starts at "      - " (6 spaces) and ends at the next step or a shallower line. */
function steps(src: string): Step[] {
  const lines = src.split("\n");
  const out: Step[] = [];
  let cur: string[] | null = null;
  const flush = () => {
    if (!cur) return;
    const text = cur.join("\n");
    const name = /- (?:name|uses):\s*(.+)/.exec(cur[0])?.[1].trim() ?? "?";
    const block = (key: string) => {
      const i = cur!.findIndex((l) => new RegExp(`^ {8}${key}:`).test(l));
      if (i < 0) return "";
      const first = cur![i].replace(new RegExp(`^ {8}${key}:\\s*`), "");
      const rest: string[] = [];
      for (let j = i + 1; j < cur!.length && (/^ {10}/.test(cur![j]) || cur![j].trim() === ""); j++) rest.push(cur![j]);
      return [first, ...rest].join("\n");
    };
    out.push({ name, text, env: block("env"), run: block("run") });
    cur = null;
  };
  for (const l of lines) {
    if (/^ {6}- /.test(l)) { flush(); cur = [l]; }
    else if (cur && (/^ {8}/.test(l) || l.trim() === "")) cur.push(l);
    else flush();
  }
  flush();
  return out;
}
/** The job-level env block(s) of a workflow (4-space "env:" inside a job). */
function jobEnv(src: string): string {
  const lines = src.split("\n"); const out: string[] = [];
  for (let i = 0; i < lines.length; i++) if (/^ {4}env:\s*$/.test(lines[i])) for (let j = i + 1; j < lines.length && /^ {6}\S|^\s*#|^\s*$/.test(lines[j]); j++) out.push(lines[j]);
  return out.join("\n");
}

test("[SEC-007] F-23: no workflow interpolates untrusted input (inputs.*, github.event.*, head_ref) into a run: script", () => {
  const bad: string[] = [];
  for (const f of files) for (const s of steps(read(f))) {
    if (/\$\{\{\s*(inputs\.|github\.event\.|github\.head_ref)/.test(s.run)) bad.push(`${f} › ${s.name}`);
  }
  assert.deepEqual(bad, [], "pass such values through env: and quote them in the script");
});

test("[SEC-007] F-23: the production release tag is validated (whole string) before anything runs", () => {
  const prod = read("deploy-production.yml");
  assert.match(prod, /RELEASE_TAG: \$\{\{ inputs\.tag \}\}/);
  const first = steps(prod)[0];
  assert.match(first.name, /Validate inputs/, "validation is the first step, before checkout and any wrangler call");
  // Run the workflow's own validation script, unchanged, against hostile values.
  const script = first.run.replace(/^\|\n/, "");
  const ok = (tag: string) => { try { execFileSync("bash", ["-c", script], { env: { ...process.env, TARGET_COMMIT: "0".repeat(40), RELEASE_TAG: tag }, stdio: "pipe" }); return true; } catch { return false; } };
  for (const t of ["", "v1.0.0", "v12.3.45", "v1.2.3-rc.1"]) assert.ok(ok(t), JSON.stringify(t));
  for (const t of ['v1.0.0"; curl https://evil.example #', "$(id)", "v1.0.0\nrm -rf /", "`id`", "1.0.0", "v1.0", "v1.0.0;id"]) assert.ok(!ok(t), JSON.stringify(t));
});

test("[SEC-007] F-24: deploy workflows hold no secret at job level, and steps that run third-party package code get none", () => {
  const bad: string[] = [];
  for (const f of ["deploy-production.yml", "deploy-staging.yml"]) {
    const src = read(f);
    if (/secrets\./.test(jobEnv(src))) bad.push(`${f}: job-level env contains a secret`);
    for (const s of steps(src)) {
      const runsPackages = /\bnpm (install|ci|test)\b|\bnpx (tsc|playwright)\b|playwright install/.test(s.run);
      if (runsPackages && /secrets\.(?!\w+ != '')/.test(s.env)) bad.push(`${f} › ${s.name}: secret in a step that runs package code`);
      // Every step that names the Cloudflare token must actually use wrangler / the Cloudflare API / a script that does.
      if (/secrets\.CLOUDFLARE_API_TOKEN \}\}/.test(s.env) && !/WRANGLER|wrangler|staging-access\.ts|staging-secrets\.ts|staging-rotation-check\.ts|staging-forensics\.ts|verify-crons\.ts|evidence-secret\.ts|trigger-scheduler\.ts|wait-mfa-budget\.ts|staging-binding-guard\.ts|outbound-staging-e2e\.ts|builder-staging-e2e\.ts|production-purchase-probe\.ts|production-data-report\.ts/.test(s.run)) // outbound- and builder-staging-e2e.ts query D1 through staging-access.ts wranglerOps; the purchase probe runs wrangler d1 execute itself
        bad.push(`${f} › ${s.name}: has the Cloudflare token but does not use Cloudflare`);
    }
  }
  // Staging is public since 2026-10-28: no step may receive or reference the retired preview-password secret.
  if (/STAGING_PREVIEW_PASSWORD|FIXED_PREVIEW_PASSWORD/.test(read("deploy-staging.yml"))) bad.push("deploy-staging.yml: references the retired preview password");
  assert.deepEqual(bad, []);
  const e2e = steps(read("deploy-staging.yml")).find((s) => /Browser journey/.test(s.name))!;
  assert.ok(e2e.run.indexOf("unset EVIDENCE_INGEST_SECRET") >= 0 && e2e.run.indexOf("unset EVIDENCE_INGEST_SECRET") < e2e.run.indexOf("npm install"), "evidence secret dropped before npm install");
});

test("[SEC-004] F-24 extended: no workflow holding the Cloudflare token at job level runs third-party package code", () => {
  // F-24 above covers deploy-production.yml and deploy-staging.yml, where the token is given to individual
  // steps so npm installs, Playwright and axe never see it. Four other workflows set it at JOB level, where
  // every step sees it:
  //
  //   production-backup.yml:restore-verify   provision-production.yml:provision
  //   staging-restore-drill.yml:drill        staging-rollback-rehearsal.yml:rehearse
  //
  // Today that is safe — audited 2026-11-05, every step in all four is first-party and uses wrangler — but it
  // is safe by accident. Adding one `npm install` step to any of them would hand the Cloudflare token to
  // package install scripts, and no test would have said a word. This is the test that says it.
  //
  // The fix if this ever fails is to move the secret down to the steps that need it, as the two deploy
  // workflows already do, not to add an exception here.
  const bad: string[] = [];
  for (const f of files) {
    const src = read(f);
    if (!/secrets\.CLOUDFLARE_API_TOKEN/.test(jobEnv(src))) continue; // step-level: already covered by F-24
    for (const s of steps(src)) {
      if (/\bnpm (install|ci|test)\b|\bnpx (?!--yes wrangler|wrangler)|playwright install/.test(s.run)) {
        bad.push(`${f} › ${s.name}: runs package code in a job that holds the Cloudflare token at job level`);
      }
    }
  }
  assert.deepEqual(bad, [], "give the token to the steps that need it instead of to the whole job");
});

test("[SEC-007] F-18/F-19: no workflow uploads unsealed access notes, credentials or a database export as an artifact", () => {
  const bad: string[] = [];
  for (const f of files) for (const s of steps(read(f))) {
    if (!/actions\/upload-artifact/.test(s.text)) continue;
    const paths = (/path:\s*\|?\s*([\s\S]*?)(?:\n {10}[a-z-]+:|$)/.exec(s.text.split("with:")[1] ?? "")?.[1] ?? "").split(/\s+/).filter(Boolean);
    for (const p of paths) {
      if (/^(access|forensics)\//.test(p) && !/\.sealed$/.test(p)) bad.push(`${f} › ${s.name}: uploads ${p}`);
      if (/backups|\.sql$|private\.json|demo-accounts|access\.json/.test(p)) bad.push(`${f} › ${s.name}: uploads ${p}`);
    }
  }
  assert.deepEqual(bad, []);
  const staging = read("deploy-staging.yml");
  assert.doesNotMatch(staging, /openssl enc/, "unauthenticated CBC encryption is not used");
  assert.doesNotMatch(staging, /upload == 'plain'|REPO_PRIVATE/, "no plaintext path, whatever the repository visibility");
  assert.match(staging, /scripts\/seal\.ts seal access\/README\.md access\/staging-access\.sealed/);
});

// ───────────── CI supply chain (CREST-GAP-028, -063) ─────────────

const nonComment = (src: string) => src.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

/**
 * A `name:` whose unquoted value contains ": " is not a string -- it is a second mapping key, and the step is invalid
 * YAML. GitHub does not say so. It names the workflow after its own file path, creates one synthetic failed run with
 * no annotation, and answers every dispatch with "Workflow does not have 'workflow_dispatch' trigger", which reads
 * like a missing trigger rather than a file it could not read. Measured on scanner-staging-verify.yml, whose step was
 * called "Apply staging access (same epoch, no rotation: the same derived passwords)".
 *
 * Line-based, like every other check here: the platform has no YAML dependency. Quoting the value also satisfies it.
 */
test("[SEC-007] a name: value containing a colon-space is unquoted YAML and silently invalidates the workflow", () => {
  const bad: string[] = [];
  for (const f of files) for (const raw of read(f).split("\n")) {
    const l = raw.replace(/\r$/, "");
    const m = /^\s*(?:-\s+)?name:\s*(.*)$/.exec(l);
    if (!m) continue;
    const v = m[1].trim();
    if (/^["']/.test(v)) continue;   // quoted: the colon is inside the scalar and harmless
    if (/:\s/.test(v)) bad.push(`${f}: ${l.trim()}`);
  }
  assert.deepEqual(bad, [], 'quote the value, or drop the colon');
});

test("[SEC-004] every action is pinned to a full 40-character commit SHA with a trailing # vN comment (tags can be moved; SHAs cannot)", () => {
  const bad: string[] = [];
  let pinned = 0;
  for (const f of files) for (const l of read(f).split("\n")) {
    const m = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(l);
    if (!m) continue;
    if (m[1].startsWith("./")) continue; // local composite action (none today)
    if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(m[1]) || !/^\s+# v\d+(\.\d+){0,2}\s*$/.test(m[2])) bad.push(`${f}: ${l.trim()}`);
    else pinned++;
  }
  assert.deepEqual(bad, [], "pin with: owner/repo@<40-hex sha> # vN (Dependabot updates both)");
  assert.ok(pinned >= 25, `all workflow actions found (${pinned})`);
});

test("[SEC-004] wrangler is pinned to an exact version in every workflow and script default (never wrangler@4 or latest)", () => {
  const bad: string[] = [];
  const sources = [...files.map((f) => [`${DIR}/${f}`, read(f)] as const), ...readdirSync("scripts").filter((f) => f.endsWith(".ts")).map((f) => [`scripts/${f}`, readFileSync(`scripts/${f}`, "utf8")] as const)];
  for (const [name, src] of sources) for (const m of nonComment(src).matchAll(/wrangler@([^\s"'`]*)/g)) if (!/^\d+\.\d+\.\d+$/.test(m[1])) bad.push(`${name}: wrangler@${m[1]}`);
  assert.deepEqual(bad, []);
  const versions = new Set(sources.flatMap(([, src]) => [...nonComment(src).matchAll(/wrangler@(\d+\.\d+\.\d+)/g)].map((m) => m[1])));
  assert.equal(versions.size, 1, `one wrangler version everywhere: ${[...versions].join(", ")}`);
});

test("[SEC-007] F-24: in workflows that hold the Cloudflare token, npm installs never run package lifecycle scripts (--ignore-scripts)", () => {
  const bad: string[] = [];
  for (const f of files) {
    const src = read(f);
    if (!/secrets\.CLOUDFLARE_API_TOKEN/.test(src)) continue;
    for (const l of nonComment(src).split("\n")) if (/\bnpm (install|i|ci)\b/.test(l) && !/--ignore-scripts/.test(l)) bad.push(`${f}: ${l.trim()}`);
  }
  assert.deepEqual(bad, [], "Playwright/axe/TypeScript installs in jobs that later hold CLOUDFLARE_API_TOKEN must not execute install scripts");
  const staging = read("deploy-staging.yml");
  assert.match(staging, /npm install --prefix \.pw [^\n]*--ignore-scripts playwright@/);
  assert.match(staging, /npm install --prefix \.pwf [^\n]*--ignore-scripts playwright@/);
});

test("[INFRA-005] CREST-GAP-058: no workflow on main deploys the retired crestmont-platform-frontend-preview Worker", () => {
  assert.deepEqual(files.filter((f) => /frontend-preview/.test(f)), [], "no deploy-frontend-preview workflow");
  const bad: string[] = [];
  for (const f of files) for (const l of nonComment(read(f)).split("\n")) if (/frontend-preview/.test(l)) bad.push(`${f}: ${l.trim()}`);
  assert.deepEqual(bad, [], "the retired Worker is named only in comments");
  const toml = readFileSync("wrangler.toml", "utf8").replace(/#.*$/gm, "");
  assert.doesNotMatch(toml, /frontend-preview|\[env\.(preview|frontend)/, "wrangler.toml has no preview environment");
});
