// Trusted integration-execution layer (Founder V4 §8), part 2: the broker between the agent and the catalogue.
//
//   agent (sandboxed, no secrets)  ── writes .crestmont/integration-operations.json: [{ operation, summary }]
//   broker (runner process)        ── unknown operation → recorded as not supported (a person handles it)
//                                  ── catalogued, not yet approved → approval request "integration_operation" (Owner)
//                                  ── rejected → recorded, never run
//                                  ── approved → reads the project's secrets itself, runs the operation once,
//                                     redacts the result, writes .crestmont/integration-results.json for the agent and
//                                     reports the test-environment status to the platform
// The agent never receives a credential, never chooses a URL or a request body, and cannot grant itself an approval
// (approvals are decided by a person on the platform; the broker only reads the decisions).

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { findOperation, RefusedOperationError } from "./catalog.ts";
import { registerSecret, redact } from "../log.ts";

export interface BrokerRequest { operation: string; summary: string }
export interface BrokerOutcome { operation: string; status: "not_supported" | "awaiting_approval" | "rejected" | "missing_credentials" | "passed" | "failed" | "refused"; evidence: string }

export interface BrokerDeps {
  repo: string;
  /** Job directory outside the repository (the broker's own record of operations already run). */
  jobDir: string;
  projectId: string;
  /** <RUNNER_SECRETS_DIR>/integrations: one sub-directory per project id, one file per secret name. */
  secretsRoot: string;
  approvals: () => Promise<{ id: string; operation: string | null; status: string; kind: string }[] | null>;
  requestApproval: (r: { kind: "integration_operation"; operation: string; summary: string; detail: string }) => Promise<unknown>;
  report: (items: { key: string; sandboxStatus: "passed" | "failed"; sandboxEvidence: string }[]) => Promise<void>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const OP = /^[a-z0-9_]{2,40}\.[a-z0-9_]{2,60}$/;

export function readRequests(repo: string): BrokerRequest[] {
  const f = path.join(repo, ".crestmont", "integration-operations.json");
  if (!existsSync(f) || statSync(f).size > 64 * 1024) return [];
  try {
    const v = JSON.parse(readFileSync(f, "utf8"));
    return (Array.isArray(v) ? v : []).filter((x) => x && typeof x.operation === "string" && OP.test(x.operation))
      .map((x) => ({ operation: x.operation as string, summary: String(x.summary ?? "").slice(0, 300) })).slice(0, 20);
  } catch { return []; }
}

function readSecrets(root: string, projectId: string, names: string[]): Record<string, string> | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) return null;
  const dir = path.join(root, projectId);
  const out: Record<string, string> = {};
  for (const n of names) {
    const f = path.join(dir, n);
    if (!existsSync(f)) return null;
    const v = readFileSync(f, "utf8").trim();
    if (!v) return null;
    registerSecret(v); // redacted from every log line from now on
    out[n] = v;
  }
  return out;
}

/** Remove anything credential-like from a result before it reaches the agent, the logs or the platform. */
export function sanitizeEvidence(text: string, secrets: Record<string, string>): string {
  let t = text;
  for (const v of Object.values(secrets)) if (v) t = t.split(v).join("[redacted]");
  return redact(t).replace(/\b(sk|rk|pk|whsec)_(test|live)_[A-Za-z0-9]+/g, "[redacted]").replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").slice(0, 500);
}

export async function runIntegrationOperations(d: BrokerDeps): Promise<BrokerOutcome[]> {
  const requests = readRequests(d.repo);
  if (!requests.length) return [];
  const doneFile = path.join(d.jobDir, "integration-operations-done.json");
  const done: Record<string, BrokerOutcome> = existsSync(doneFile) ? (() => { try { return JSON.parse(readFileSync(doneFile, "utf8")); } catch { return {}; } })() : {};
  const decisions = await d.approvals();
  const out: BrokerOutcome[] = [];
  for (const req of requests) {
    if (done[req.operation]) { out.push(done[req.operation]); continue; }
    const op = findOperation(req.operation);
    if (!op) { out.push({ operation: req.operation, status: "not_supported", evidence: "not in the runner's integration catalogue: a person must perform or review this step" }); continue; }
    const decision = decisions?.filter((a) => a.kind === "integration_operation" && a.operation === op.id).at(-1);
    if (!decision) {
      await d.requestApproval({ kind: "integration_operation", operation: op.id, summary: `Run ${op.id} for this website (test environment)`, detail: `${op.description} Requested by the builder: ${req.summary || "(no reason given)"}. Uses the project's ${op.secrets.join(", ")} from the runner's secrets; contacts ${op.hosts.join(", ")}.` });
      out.push({ operation: op.id, status: "awaiting_approval", evidence: "waiting for the Owner's approval on the platform" });
      continue;
    }
    if (decision.status === "pending") { out.push({ operation: op.id, status: "awaiting_approval", evidence: "waiting for the Owner's approval on the platform" }); continue; }
    if (decision.status !== "approved") { const r: BrokerOutcome = { operation: op.id, status: "rejected", evidence: "the Owner rejected this operation" }; done[op.id] = r; out.push(r); continue; }
    const secrets = readSecrets(d.secretsRoot, d.projectId, op.secrets);
    if (!secrets) { out.push({ operation: op.id, status: "missing_credentials", evidence: `approved, but ${op.secrets.join(", ")} is not in the runner's integration secrets for this project yet (Founder action)` }); continue; }
    let r: BrokerOutcome;
    try {
      const res = await op.run({ secrets, fetchImpl: d.fetchImpl ?? fetch, signal: AbortSignal.timeout(d.timeoutMs ?? 30_000) });
      r = { operation: op.id, status: res.ok ? "passed" : "failed", evidence: sanitizeEvidence(res.evidence, secrets) };
    } catch (err) {
      r = { operation: op.id, status: err instanceof RefusedOperationError ? "refused" : "failed", evidence: sanitizeEvidence((err as Error).message ?? String(err), secrets) };
    }
    done[op.id] = r;
    out.push(r);
    if (r.status === "passed" || r.status === "failed" || r.status === "refused") await d.report([{ key: op.integration, sandboxStatus: r.status === "passed" ? "passed" : "failed", sandboxEvidence: `${op.id}: ${r.evidence}` }]);
  }
  mkdirSync(d.jobDir, { recursive: true });
  writeFileSync(doneFile, JSON.stringify(done));
  // The agent sees the sanitized outcome only.
  mkdirSync(path.join(d.repo, ".crestmont"), { recursive: true });
  writeFileSync(path.join(d.repo, ".crestmont", "integration-results.json"), JSON.stringify(out, null, 2) + "\n");
  return out;
}
