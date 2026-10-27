// Reading the agent's status files and normalizing requirement items to protocol limits, honestly:
// a "verified" claim without evidence is downgraded to implemented_unverified, "blocked" without a blocker gets one.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { RequirementItem, RequirementStatus } from "./protocol.ts";
import { REQUIREMENT_STATUSES, LIMITS } from "./protocol.ts";
import type { CheckOutcome } from "./checks.ts";

function readJson(file: string): unknown {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

export function normalizeItem(raw: unknown): RequirementItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const key = typeof r.key === "string" ? r.key.trim().slice(0, 120) : "";
  if (!key) return null;
  let status = (REQUIREMENT_STATUSES as readonly string[]).includes(String(r.status)) ? (r.status as RequirementStatus) : "remaining";
  const evidence = typeof r.evidence === "string" && r.evidence.trim() ? r.evidence.trim().slice(0, LIMITS.evidence) : undefined;
  let blocker = typeof r.blocker === "string" && r.blocker.trim() ? r.blocker.trim().slice(0, LIMITS.blocker) : undefined;
  if (status === "verified" && !evidence) status = "implemented_unverified";
  if (status === "blocked" && !blocker) blocker = "Blocked (no reason recorded by the agent)";
  const item: RequirementItem = { key, status };
  if (typeof r.label === "string" && r.label.trim()) item.label = r.label.trim().slice(0, 200);
  if (evidence) item.evidence = evidence;
  if (status === "blocked" && blocker) item.blocker = blocker;
  return item;
}

/** Seed (from claim) overlaid with the agent's requirements.json; seed keys are never dropped. */
export function readRequirements(repo: string, seed: RequirementItem[]): RequirementItem[] {
  const byKey = new Map<string, RequirementItem>();
  for (const s of seed) { const n = normalizeItem(s); if (n) byKey.set(n.key, n); }
  const agent = readJson(path.join(repo, ".crestmont", "requirements.json"));
  if (Array.isArray(agent)) {
    for (const raw of agent.slice(0, 500)) {
      const n = normalizeItem(raw);
      if (!n) continue;
      const prev = byKey.get(n.key);
      byKey.set(n.key, { ...n, label: n.label ?? prev?.label });
    }
  }
  return [...byKey.values()].map((r) => (r.label === undefined ? (({ label: _l, ...rest }) => rest)(r) : r));
}

/** The runner's own check results become requirement items (only these are runner-verified). */
export function checkRequirements(checks: CheckOutcome[]): RequirementItem[] {
  return checks.map((c) => c.ok
    ? { key: `check:${c.id}`, label: c.label, status: "verified" as const, evidence: `Runner ran \`${c.command}\`: exit 0`.slice(0, LIMITS.evidence) }
    : { key: `check:${c.id}`, label: c.label, status: "blocked" as const, blocker: `Runner ran \`${c.command}\`: exit ${c.code}${c.timedOut ? " (timed out)" : ""}`.slice(0, LIMITS.blocker) });
}

export function readStringList(repo: string, file: string, max = 50): string[] {
  const v = readJson(path.join(repo, ".crestmont", file));
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, max).map((s) => s.trim().slice(0, 300));
}

export function readAgentReport(repo: string): string | null {
  const f = path.join(repo, ".crestmont", "agent-report.md");
  if (!existsSync(f)) return null;
  return readFileSync(f, "utf8").slice(0, 30_000);
}
