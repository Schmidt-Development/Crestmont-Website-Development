// Owner report (Markdown, ≤ 50 KB) sent with `complete`. Internal: shown to the owner, never to customers.
// Statuses are reported as recorded; the runner never upgrades a status the agent could not evidence.

import type { Job, Outcome, RequirementItem } from "./protocol.ts";
import type { CheckOutcome } from "./checks.ts";
import { fenceFor } from "./prompt.ts";
import { truncateBytes } from "./control-plane.ts";
import { LIMITS } from "./protocol.ts";

export interface ReportInput {
  job: Job;
  outcome: Outcome;
  stopReason: string | null;
  error: string | null;
  requirements: RequirementItem[];
  checks: CheckOutcome[];
  preview: { url: string | null; note: string };
  source: { repoUrl: string | null; branch: string; commit: string | null; pushed: boolean; note: string; workspace: string };
  costUsd: number;
  turns: number;
  costCaveats: string[];
  sessionId: string | null;
  sessionNotes: string[];
  skills: { provisioned: string[]; missingOptional: string[] };
  assumptions: string[];
  missingInformation: string[];
  agentReport: string | null;
  envVarNames: string[];
  starter: string | null;
  /** Which agent provider ran and its model usage. Absent = Agent SDK wording (runner 1.0 behaviour). */
  usage?: { provider: string; model: string; paid: boolean; inputTokens: number; outputTokens: number; modelWallMs: number; modelCalls: number };
}

const OUTCOME_TEXT: Record<Outcome, string> = {
  ready_for_review: "Ready for owner review",
  needs_information: "Needs information",
  failed: "Failed",
  stopped: "Stopped",
  released: "Released by the runner (will resume)",
};

function list(items: string[], empty = "- None"): string {
  return items.length ? items.map((i) => `- ${i.replace(/\s*\n\s*/g, " ")}`).join("\n") : empty;
}

function reqLine(r: RequirementItem): string {
  const label = r.label ? `${r.label} (\`${r.key}\`)` : `\`${r.key}\``;
  if (r.status === "verified") return `${label}: verified. Evidence: ${r.evidence ?? ""}`;
  if (r.status === "blocked") return `${label}: blocked. ${r.blocker ?? ""}`;
  if (r.status === "implemented_unverified") return `${label}: implemented, not verified${r.evidence ? `. Notes: ${r.evidence}` : ""}`;
  return `${label}: remaining`;
}

export function buildReport(i: ReportInput): string {
  const by = (s: RequirementItem["status"]) => i.requirements.filter((r) => r.status === s);
  const out: string[] = [];
  out.push(`# AI build report: ${OUTCOME_TEXT[i.outcome]}`);
  out.push("");
  out.push(`Job \`${i.job.id}\` (attempt ${i.job.attempt}, ${i.job.kind}${i.job.kind === "revision" ? ` ${i.job.revision}` : ""}) for project \`${i.job.projectId}\`; ` +
    `strategy ${i.job.strategy}${i.job.packageId ? `, package ${i.job.packageId}` : ""}${i.starter ? `, starter ${i.starter}` : ""}.`);
  out.push(`Brief ${i.job.brief.id} v${i.job.brief.version}.`);
  if (i.stopReason) out.push(`Stopped because: ${i.stopReason}.`);
  if (i.error) out.push(`Error: ${i.error}`);
  out.push("");
  out.push("This is an internal draft for owner review. Nothing was published to production or sent to the customer.");
  out.push("");
  out.push("## Completed");
  out.push(list([...by("verified"), ...by("implemented_unverified")].map(reqLine)));
  out.push("");
  out.push("## Remaining");
  out.push(list(by("remaining").map(reqLine)));
  out.push("");
  out.push("## Blocked");
  out.push(list(by("blocked").map(reqLine)));
  out.push("");
  out.push("## Information needed from the customer or owner");
  out.push(list(i.missingInformation));
  out.push("");
  out.push("## Assumptions");
  out.push(list(i.assumptions));
  out.push("");
  out.push("## Checks run by the runner");
  out.push(i.checks.length
    ? i.checks.map((c) => `- ${c.ok ? "PASS" : "FAIL"} \`${c.command}\` (exit ${c.code}${c.timedOut ? ", timed out" : ""})`).join("\n")
    : "- No automated acceptance checks were run.");
  const failed = i.checks.filter((c) => !c.ok);
  for (const c of failed) {
    const f = fenceFor(c.outputTail);
    out.push("", `Output tail of \`${c.id}\`:`, f, c.outputTail, f);
  }
  out.push("");
  out.push("## Preview");
  out.push(i.preview.url ? `- ${i.preview.url} (preview/test resources only)` : `- Preview unavailable: ${i.preview.note}`);
  out.push("");
  out.push("## Source");
  if (i.source.repoUrl) out.push(`- Repository: ${i.source.repoUrl} (branch \`${i.source.branch}\`)${i.source.pushed ? "" : " — NOT pushed"}`);
  out.push(`- Commit: ${i.source.commit ?? "(no commits)"}`);
  out.push(`- Runner workspace: \`${i.source.workspace}\``);
  if (i.source.note) out.push(`- ${i.source.note}`);
  out.push("");
  out.push("## How to run locally");
  if (i.job.strategy === "standard") {
    out.push("```sh", `git clone ${i.source.repoUrl ?? "<repository>"} && cd <directory> && git checkout ${i.source.branch}`,
      "npm run check          # offline HTML/link/SEO/responsive checks", "npx wrangler dev       # serves public/ and the /api/contact stub on http://localhost:8787", "```");
  } else {
    out.push("See README.md / ARCHITECTURE.md in the repository. Typical: `npm install`, then `npm test` and the dev script listed in package.json.");
  }
  out.push("");
  out.push("## Environment variables (names only)");
  out.push(list(i.envVarNames.map((n) => `\`${n}\``)));
  out.push("");
  out.push("## Run details");
  if (i.usage && !i.usage.paid) {
    out.push(`- Agent: local provider, self-hosted model \`${i.usage.model}\` (no per-token fees; model spend this attempt: $0.00)`);
    out.push(`- Model usage this attempt: ${i.usage.modelCalls} model calls, ${i.usage.inputTokens} input tokens, ${i.usage.outputTokens} output tokens, ${Math.round(i.usage.modelWallMs / 1000)} s waiting for the model`);
  } else {
    if (i.usage) out.push(`- Agent: ${i.usage.provider} (paid adapter, explicitly enabled), model \`${i.usage.model}\``);
    out.push(`- Estimated model spend this attempt: $${i.costUsd.toFixed(2)} (Agent SDK client-side estimate; authoritative billing is in the Claude Console)`);
  }
  out.push(`- Agent turns this attempt: ${i.turns}`);
  out.push(`- Session: ${i.sessionId ?? "(none)"}`);
  for (const n of [...i.sessionNotes, ...i.costCaveats]) out.push(`- ${n}`);
  out.push(`- Skills provisioned: ${i.skills.provisioned.join(", ") || "none"}`);
  if (i.skills.missingOptional.length) out.push(`- Optional skills unavailable: ${i.skills.missingOptional.join(", ")}`);
  out.push("");
  if (i.agentReport) {
    out.push("## Agent's own report (unverified narrative; statuses above are authoritative)");
    const body = i.agentReport.slice(0, 20_000);
    const f = fenceFor(body);
    out.push(f + "markdown", body, f);
  }
  return truncateBytes(out.join("\n") + "\n", LIMITS.report);
}
