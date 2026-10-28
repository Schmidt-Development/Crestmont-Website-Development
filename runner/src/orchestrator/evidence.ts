// Evidence the orchestrator collects after each implementation cycle (V3 §7B): what changed (git), what the
// runner's own checks found, which screenshots exist, the builder's requirement statuses (labelled as builder-reported;
// the separate review session judges them), and the builder's structured outputs (integration status, approval
// requests). Nothing here executes workspace code.

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { run } from "../exec.ts";
import type { CheckOutcome } from "../checks.ts";
import type { RequirementItem } from "../protocol.ts";
import type { CycleEvidence, MasterSpec } from "./contracts.ts";

const readJson = (file: string): unknown => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

async function gitLines(repo: string, pathEnv: string, home: string, args: string[]): Promise<string[]> {
  const r = await run("git", args, { cwd: repo, env: { PATH: pathEnv, HOME: home, GIT_CONFIG_NOSYSTEM: "1" }, timeoutMs: 60_000 });
  return r.code === 0 ? r.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

export async function collectEvidence(o: {
  repo: string; pathEnv: string; home: string; baseCommit: string | null; checks: CheckOutcome[]; requirements: RequirementItem[]; spec: MasterSpec | null;
}): Promise<CycleEvidence> {
  const range = o.baseCommit ? [`${o.baseCommit}..HEAD`] : ["-n", "20"];
  const commits = (await gitLines(o.repo, o.pathEnv, o.home, ["log", "--format=%H", ...range])).slice(0, 50);
  const changedFiles = o.baseCommit ? (await gitLines(o.repo, o.pathEnv, o.home, ["diff", "--name-only", `${o.baseCommit}..HEAD`])).slice(0, 500) : [];
  const shotsDir = path.join(o.repo, ".crestmont", "screenshots");
  const screenshots = existsSync(shotsDir) ? readdirSync(shotsDir).filter((f) => /-(desktop|mobile)\.png$/.test(f)).map((f) => ({
    path: `.crestmont/screenshots/${f}`, viewport: (f.endsWith("-mobile.png") ? "mobile" : "desktop") as "desktop" | "mobile", page: f.replace(/-(desktop|mobile)\.png$/, ""),
  })).slice(0, 200) : [];
  // Criteria: the spec's acceptance criteria, with the status the builder recorded in .crestmont/acceptance.json.
  const reported = readJson(path.join(o.repo, ".crestmont", "acceptance.json"));
  const statusOf = new Map<string, string>(Array.isArray(reported) ? reported.filter((x) => x && typeof x.id === "string").map((x) => [x.id, String(x.status)]) : []);
  const criteria = (o.spec?.acceptanceCriteria ?? []).map((c) => ({ id: c.id, status: (statusOf.get(c.id) === "passed" ? "passed" : statusOf.get(c.id) === "failed" ? "failed" : "not_verified") as "passed" | "failed" | "not_verified" }));
  // Without a spec, the brief's requirement checklist plays the same role.
  if (!o.spec) for (const r of o.requirements) criteria.push({ id: `req-${r.key.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 50)}`, status: r.status === "verified" ? "passed" : r.status === "blocked" ? "failed" : "not_verified" });
  const integ = readJson(path.join(o.repo, ".crestmont", "integrations.json"));
  const integrationBlockers = Array.isArray(integ) ? integ.filter((x) => x && typeof x.key === "string" && x.liveStatus !== "verified_live").map((x) => `${x.key}: live connection needs ${String(x.needs ?? "credentials")}`.slice(0, 300)) : [];
  const report = existsSync(path.join(o.repo, ".crestmont", "agent-report.md")) ? readFileSync(path.join(o.repo, ".crestmont", "agent-report.md"), "utf8") : "";
  const list = (name: string) => { const v = readJson(path.join(o.repo, ".crestmont", name)); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 500)).slice(0, 100) : []; };
  return {
    summary: report.slice(0, 5000),
    changedFiles, commits,
    checks: o.checks.map((c) => ({ id: c.id, ok: c.ok, detail: c.ok ? undefined : (c.outputTail ?? "").slice(-400) })),
    screenshots, criteria,
    defects: list("defects.json"), integrationBlockers, securityFindings: list("security-findings.json"), recommendedNext: list("next-steps.json"),
  };
}

/** Builder-declared integration status (code + mock only; "live" is recorded by a person on the platform). */
export function builderIntegrations(repo: string): { key: string; codeStatus?: string; mockStatus?: string; name?: string; purpose?: string }[] {
  const v = readJson(path.join(repo, ".crestmont", "integrations.json"));
  return Array.isArray(v) ? v.filter((x) => x && typeof x.key === "string").slice(0, 50) : [];
}

/** Sensitive actions the builder asked for (it keeps working; the Owner decides on the platform). */
export function builderApprovalRequests(repo: string): { kind: string; summary: string; detail?: string }[] {
  const v = readJson(path.join(repo, ".crestmont", "approval-requests.json"));
  return Array.isArray(v) ? v.filter((x) => x && typeof x.kind === "string" && typeof x.summary === "string").slice(0, 20) : [];
}

/** The reviewer's corrective prompt, kept in the workspace for the builder and the next checkpoint. */
export function writeReview(repo: string, cycle: number, decision: string, prompt: string | null, findings: string[]): void {
  mkdirSync(path.join(repo, ".crestmont"), { recursive: true });
  writeFileSync(path.join(repo, ".crestmont", `review-${String(cycle).padStart(2, "0")}.md`), [`# Review of cycle ${cycle}: ${decision}`, "", ...findings.map((f) => `- ${f}`), "", prompt ? `## Next prompt\n\n${prompt}` : ""].join("\n"));
}

/** Instructions appended to builder prompts so the evidence files exist (V3 §7B, §8, §9). */
export const BUILDER_CONTRACT = [
  "Orchestrator contract (every session):",
  "- Follow SPEC.json (the architect's master specification) when it exists; record each acceptance criterion's status in .crestmont/acceptance.json as [{\"id\",\"status\":\"passed|failed|not_verified\",\"evidence\"}] — passed only with a test or screenshot that proves it.",
  "- Third-party integrations: implement the UI, adapter, webhooks, data model, error handling, mocks and sandbox tests even without credentials; record [{\"key\",\"codeStatus\",\"mockStatus\",\"needs\"}] in .crestmont/integrations.json. Never invent credentials and never claim a live connection.",
  "- Sensitive actions (credentials, external accounts, purchases, production publishing, DNS, destructive operations outside the workspace, privileged access, security/legal decisions): do not attempt them; add [{\"kind\",\"summary\",\"detail\"}] to .crestmont/approval-requests.json (kinds: credential_request, external_account_connection, sensitive_customer_system, paid_usage_increase, purchase, infrastructure_permission, production_publish, dns_change, destructive_outside_workspace, privileged_access, security_or_legal_decision) and continue with all other work.",
  "- Checks against a provider's TEST environment (for example that the project's Stripe test key works) are run by the runner, never by you: list them in .crestmont/integration-operations.json as [{\"operation\",\"summary\"}] (available: stripe.verify_test_key, stripe.list_test_webhooks). After the Owner approves, the sanitized result appears in .crestmont/integration-results.json. You never receive the credentials.",
  "- Known defects go in .crestmont/defects.json, security findings in .crestmont/security-findings.json, suggested next steps in .crestmont/next-steps.json (string arrays).",
].join("\n");
