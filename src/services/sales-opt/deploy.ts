// Safe Retell deployment for the sales agent (SALESOPT-008). Uses only documented Retell endpoints, through the
// existing adapter (src/adapters/retell.ts): GET /get-agent/{agent_id}, GET /get-retell-llm/{llm_id},
// PATCH /update-retell-llm/{llm_id} with { general_prompt }.
//
// Sequence (every step recorded on the so_deployments row):
//   preconditions → lock (one in-flight deployment per stage) → compare-and-swap on the expected current version →
//   read agent (must be a retell-llm agent, never the receptionist) → snapshot the LLM's current prompt →
//   drift check against what the platform last verified → validate the protected policy → PATCH → read back →
//   verified only if the read-back equals the composed prompt exactly; otherwise the snapshot is restored.
//
// Retell versioning (docs.retellai.com/agent/version): PATCH changes the agent's editable draft. Published versions
// are immutable and a phone number can be pinned to one. This module never publishes and never changes a phone
// number: after a verified production update the Founder publishes in the Retell dashboard. `published` records
// what Retell reported on read-back.
//
// Production additionally requires: the environment is production, SALES_OPT_PRODUCTION=on, the Founder's
// activation switch, a Founder-approved version, and a prior verified staging deployment of that same version.
import { retellKey } from "../../adapters/retell-workspaces.ts";
import type { Db } from "../../lib/db.ts";
import { newId, nowIso } from "../../lib/db.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import type { Env } from "../../app/context.ts";
import { audit } from "../security.ts";
import { notifyOwners } from "../voice-common.ts";
import { getRetellAgent, getRetellLlm, updateRetellLlmPrompt } from "../../adapters/retell.ts";
import { composeSalesPrompt, hasProtectedPolicy, salesPolicyViolations } from "../../domain/sales-opt/policy.ts";
import { deployedVersion, getVersion, listTargets, loadControl, receptionistAgentIds, SalesOptError, type Stage } from "./registry.ts";

export const PRODUCTION_FLAG = "SALES_OPT_PRODUCTION";
export const MAX_DEPLOYS_PER_DAY = 6;
export const MIN_GAP_MS = 60_000;

export interface DeployDeps { db: Db; env: Pick<Env, "RETELL_OUTBOUND_API_KEY" | "ENVIRONMENT" | "SALES_OPT_PRODUCTION">; fetch: typeof fetch; now?: () => Date }
export interface DeployRequest { stage: Stage; versionId: string; expectedCurrentVersionId: string | null; kind: "deploy" | "rollback"; userId: string | null; reason: string }
export interface DeployResult { id: string; status: "verified" | "failed" | "aborted"; detail: string; published: boolean | null }

/** A deployment lock older than this is treated as abandoned (Worker stopped mid-deploy); the drift check then decides. */
export const LOCK_LEASE_MS = 10 * 60_000;

/**
 * Agents whose Retell LLM must never be written by `stage`: the receptionist's agents and the other stage's agent.
 * Retell agents can share one LLM, so comparing agent ids is not enough.
 */
async function protectedLlmIds(d: DeployDeps, stage: Stage): Promise<{ ids: Map<string, string>; error: string | null }> {
  const ids = new Map<string, string>();
  const other = (await listTargets(d.db))[stage === "staging" ? "production" : "staging"];
  const agents: [string, string][] = [...(await receptionistAgentIds(d.db))].map((a) => [a, "the AI receptionist"]);
  if (other) agents.push([other.agent_id, `the ${other.stage} sales agent`]);
  for (const [agentId, who] of agents) {
    const a = await getRetellAgent({ apiKey: retellKey(d.env, "outbound")!, fetch: d.fetch, agentId });
    if (!a.ok) {
      // A receptionist/other agent that cannot be read cannot be proven separate.
      if (a.status === 404) continue;
      return { ids, error: `Could not read ${who}'s agent to confirm it uses a different LLM: ${a.error}` };
    }
    const llm = a.body.response_engine?.llm_id;
    if (llm) ids.set(llm, who);
  }
  return { ids, error: null };
}

/**
 * The four Retell facts this platform keeps apart (docs/voice/SALES-OPTIMIZATION.md §1):
 *  1. draft      — does the LLM's editable general_prompt equal the version the platform last verified here? (read-only check)
 *  2. published  — Retell's is_published for that LLM version (publishing is a dashboard step; never done here)
 *  3. assignment — which agent version a phone number serves (Phone Numbers tab; never read or changed here)
 *  4. traffic    — whether real calls reach the agent (this platform never places or routes calls)
 * Only (1) can be verified by this engine; (2) is reported as Retell states it; (3) and (4) are always "not managed".
 */
export interface RetellState {
  llmId: string; llmVersion: number | null; published: boolean | null;
  draft: "matches_verified" | "differs_from_verified" | "no_verified_deployment" | "unreadable";
  verifiedVersionSeq: number | null; detail: string | null;
}

export async function retellState(d: DeployDeps, stage: Stage, llmId: string): Promise<RetellState> {
  // A verified deployment counts only for the LLM it was written to (the stage may have been re-registered since).
  const dep = await d.db.prepare(`SELECT version_id, llm_id FROM so_deployments WHERE stage = ? AND status = 'verified' ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(stage).first<{ version_id: string; llm_id: string | null }>();
  const cur = dep && dep.llm_id === llmId ? await getVersion(d.db, dep.version_id) : null;
  const back = await getRetellLlm({ apiKey: retellKey(d.env, "outbound")!, fetch: d.fetch, llmId });
  if (!back.ok) return { llmId, llmVersion: null, published: null, draft: "unreadable", verifiedVersionSeq: cur?.seq ?? null, detail: back.error };
  const text = typeof back.body.general_prompt === "string" ? back.body.general_prompt : "";
  return {
    llmId, llmVersion: typeof back.body.version === "number" ? back.body.version : null,
    published: typeof back.body.is_published === "boolean" ? back.body.is_published : null,
    draft: !cur ? "no_verified_deployment" : (await sha256Hex(text)) === cur.prompt_sha256 ? "matches_verified" : "differs_from_verified",
    verifiedVersionSeq: cur?.seq ?? null, detail: null,
  };
}

export function describeRetellState(s: RetellState): string {
  const draft = { matches_verified: `matches verified v${s.verifiedVersionSeq}`, differs_from_verified: `DIFFERS from verified v${s.verifiedVersionSeq} (edited outside the platform?)`, no_verified_deployment: "no version verified here yet", unreadable: `could not be read (${s.detail ?? "error"})` }[s.draft];
  return `Draft prompt: ${draft}. Retell LLM version ${s.llmVersion ?? "unknown"}, published: ${s.published === null ? "unknown" : s.published ? "yes" : "no"}. Phone-number version assignment and live traffic: not managed by this platform.`;
}

export interface ProductionGate { open: boolean; reasons: string[] }
export async function productionGate(db: Db, env: DeployDeps["env"]): Promise<ProductionGate> {
  const reasons: string[] = [];
  if (env.ENVIRONMENT !== "production") reasons.push(`this is the ${env.ENVIRONMENT} environment; production deployments run only from production`);
  if (env.SALES_OPT_PRODUCTION !== "on") reasons.push(`${PRODUCTION_FLAG} is not "on"`);
  if (!(await loadControl(db)).productionActivated) reasons.push("the Founder has not activated production deployment");
  if (!retellKey(env, "outbound")) reasons.push("RETELL_OUTBOUND_API_KEY is not set");
  const t = (await listTargets(db)).production;
  if (!t) reasons.push("no production sales agent is registered");
  else if (t.engine_type !== "retell-llm" || !t.llm_id) reasons.push("the production sales agent has not been verified as a Retell LLM agent");
  return { open: reasons.length === 0, reasons };
}

/** Reads the agent and records its response engine. Only a retell-llm engine can be deployed by this module. Read-only on Retell. */
export async function verifyTarget(d: DeployDeps, stage: Stage, userId: string | null): Promise<{ ok: boolean; detail: string }> {
  const t = (await listTargets(d.db))[stage];
  if (!t) return { ok: false, detail: `No ${stage} sales agent is registered.` };
  const done = async (ok: boolean, detail: string, engine: string | null) => {
    await audit(d.db, { actorUserId: userId, actorKind: userId ? "user" : "system", action: "salesopt.target_verified", subjectType: "so_target", subjectId: stage, details: { ok, engine } });
    return { ok, detail };
  };
  if (!retellKey(d.env, "outbound")) return done(false, "RETELL_OUTBOUND_API_KEY (the sales workspace key) is not set in this environment. Nothing was sent to Retell.", null);
  if ((await receptionistAgentIds(d.db)).has(t.agent_id)) return done(false, "This agent id is now used by the AI receptionist; refusing.", null);
  const a = await getRetellAgent({ apiKey: retellKey(d.env, "outbound")!, fetch: d.fetch, agentId: t.agent_id });
  if (!a.ok) return done(false, `Reading agent: ${a.error}`, null);
  const eng = a.body.response_engine ?? {};
  const type = typeof eng.type === "string" ? eng.type.slice(0, 30) : "unknown";
  if (type === "retell-llm" && eng.llm_id) {
    const prot = await protectedLlmIds(d, stage);
    if (prot.error) return done(false, prot.error, type);
    const clash = prot.ids.get(eng.llm_id);
    if (clash) return done(false, `This agent shares Retell LLM ${eng.llm_id} with ${clash}. Give the sales agent its own LLM; a shared LLM would change ${clash} too.`, type);
  }
  await d.db.prepare(`UPDATE so_targets SET engine_type = ?, llm_id = ?, verified_at = ?, updated_by = COALESCE(?, updated_by) WHERE stage = ?`)
    .bind(type, type === "retell-llm" && eng.llm_id ? eng.llm_id : null, nowIso(), userId, stage).run();
  if (type === "retell-llm" && eng.llm_id) {
    const st = await retellState(d, stage, eng.llm_id);
    return done(true, `Agent uses Retell LLM ${eng.llm_id}; the general prompt can be managed here. ${describeRetellState(st)}`, type);
  }
  return done(false, `Agent uses a "${type}" response engine. Only Retell LLM agents are supported; conversation-flow and custom-LLM agents need a different update method that is not implemented.`, type);
}

export async function deploy(d: DeployDeps, r: DeployRequest): Promise<DeployResult> {
  const db = d.db;
  const now = d.now ?? (() => new Date());
  const v = await getVersion(db, r.versionId);
  if (!v) throw new SalesOptError("Version not found", 404);
  const targets = await listTargets(db);
  const target = targets[r.stage];
  if (!target) throw new SalesOptError(`No ${r.stage} sales agent is registered.`, 409);
  if (!retellKey(d.env, "outbound")) throw new SalesOptError("RETELL_OUTBOUND_API_KEY (the sales workspace key) is not set in this environment. Nothing was sent to Retell.", 409);
  if ((await receptionistAgentIds(db)).has(target.agent_id)) throw new SalesOptError("The registered sales agent is the AI receptionist. Refusing to change it.", 409);
  if (r.stage === "staging" && !["eval_passed", "approved"].includes(v.status) && r.kind === "deploy") throw new SalesOptError("Only a version that passed evaluation can be deployed to staging.", 409);
  if (r.stage === "production") {
    const gate = await productionGate(db, d.env);
    if (!gate.open) throw new SalesOptError(`Production deployment is not available: ${gate.reasons.join("; ")}.`, 409);
    if (v.status !== "approved") throw new SalesOptError("Only a Founder-approved version can be deployed to production.", 409);
    const staged = await db.prepare(`SELECT 1 AS x FROM so_deployments WHERE stage = 'staging' AND version_id = ? AND status IN ('verified','superseded')`).bind(v.id).first();
    if (!staged && r.kind === "deploy") throw new SalesOptError("Deploy and verify this version on the staging agent first.", 409);
  }
  const current = await deployedVersion(db, r.stage);
  if ((current?.id ?? null) !== r.expectedCurrentVersionId) throw new SalesOptError(`The ${r.stage} agent's version changed (now ${current ? `v${current.seq}` : "none"}). Reload before deploying.`, 409);
  if (current?.id === v.id) throw new SalesOptError(`v${v.seq} is already deployed on ${r.stage}.`, 409);
  const prompt = composeSalesPrompt(v.instructions);
  const problems = salesPolicyViolations(v.instructions);
  if (!hasProtectedPolicy(prompt) || problems.length) throw new SalesOptError(`Refusing: the composed prompt fails the protected policy (${problems.join(" ") || "policy prefix missing"}).`, 409);
  const dayAgo = new Date(now().getTime() - 86_400_000).toISOString();
  const recent = await db.prepare(`SELECT COUNT(*) AS n, MAX(created_at) AS last FROM so_deployments WHERE stage = ? AND created_at >= ? AND status <> 'aborted'`).bind(r.stage, dayAgo).first<{ n: number; last: string | null }>();
  if (r.kind === "deploy" && recent && recent.n >= MAX_DEPLOYS_PER_DAY) throw new SalesOptError(`At most ${MAX_DEPLOYS_PER_DAY} deployments per stage per day.`, 429);
  if (r.kind === "deploy" && recent?.last && now().getTime() - Date.parse(recent.last) < MIN_GAP_MS) throw new SalesOptError("Wait a minute between deployments.", 429);

  // An abandoned lock (Worker stopped between write and record) expires; the drift check below then refuses a
  // normal deploy until the Founder has reviewed the snapshot, while a rollback may still restore a known-good version.
  await db.prepare(`UPDATE so_deployments SET status = 'aborted', detail = 'Lock expired: the deployment did not finish. Check the agent in Retell; the next deployment compares its prompt (drift check).', completed_at = ? WHERE stage = ? AND status = 'in_progress' AND created_at < ?`)
    .bind(nowIso(), r.stage, new Date(now().getTime() - LOCK_LEASE_MS).toISOString()).run();
  const id = newId("sod");
  try {
    await db.prepare(`INSERT INTO so_deployments (id, stage, version_id, expected_current_version_id, kind, status, agent_id, initiated_by, reason, created_at) VALUES (?,?,?,?,?, 'in_progress', ?,?,?,?)`)
      .bind(id, r.stage, v.id, r.expectedCurrentVersionId, r.kind, target.agent_id, r.userId, r.reason.slice(0, 500), now().toISOString()).run();
  } catch (e) {
    if (/UNIQUE/.test((e as Error).message)) throw new SalesOptError(`Another ${r.stage} deployment is in progress.`, 409);
    throw e;
  }
  // The sales agent and its Self-Improvement Engine live in the outbound workspace: only that key is used.
  const key = retellKey(d.env, "outbound")!; // checked above: no key → refused before any lock
  const finish = async (status: DeployResult["status"], detail: string, extra: Partial<{ llm: string; snapSha: string; snap: string; snapVer: number | null; readback: string; verAfter: number | null; published: boolean | null }> = {}): Promise<DeployResult> => {
    await db.prepare(`UPDATE so_deployments SET status = ?, detail = ?, llm_id = COALESCE(?, llm_id), snapshot_prompt_sha256 = COALESCE(?, snapshot_prompt_sha256), snapshot_prompt = COALESCE(?, snapshot_prompt),
        snapshot_retell_version = COALESCE(?, snapshot_retell_version), readback_sha256 = ?, retell_version_after = ?, published = ?, completed_at = ? WHERE id = ?`)
      .bind(status, detail.slice(0, 1000), extra.llm ?? null, extra.snapSha ?? null, extra.snap ?? null, extra.snapVer ?? null, extra.readback ?? null, extra.verAfter ?? null,
        extra.published === undefined || extra.published === null ? null : extra.published ? 1 : 0, nowIso(), id).run();
    if (status === "verified") {
      await db.prepare(`UPDATE so_deployments SET status = 'superseded' WHERE stage = ? AND status = 'verified' AND id <> ?`).bind(r.stage, id).run();
    }
    await audit(db, { actorUserId: r.userId, actorKind: r.userId ? "user" : "system", action: `salesopt.${r.kind}_${status}`, subjectType: "so_deployment", subjectId: id, details: { stage: r.stage, version: v.seq } });
    if (status !== "verified" || r.stage === "production") {
      await notifyOwners(db, `salesopt_${r.kind}_${status}`, `Sales agent ${r.kind} of v${v.seq} to ${r.stage}: ${status}. ${detail.slice(0, 240)}`, "so_deployment", id);
    }
    return { id, status, detail, published: extra.published ?? null };
  };

  // Compare-and-swap again now that the lock is held: another deployment may have finished in between.
  if (((await deployedVersion(db, r.stage))?.id ?? null) !== (current?.id ?? null)) return finish("aborted", "Another deployment finished while this one was starting. Reload and try again. Nothing was changed.");
  const agent = await getRetellAgent({ apiKey: key, fetch: d.fetch, agentId: target.agent_id });
  if (!agent.ok) return finish("aborted", `Reading agent: ${agent.error}. Nothing was changed.`);
  const eng = agent.body.response_engine ?? {};
  if (eng.type !== "retell-llm" || !eng.llm_id) return finish("aborted", `Agent does not use a Retell LLM response engine (${String(eng.type ?? "unknown").slice(0, 30)}). Nothing was changed.`);
  if (target.llm_id && target.llm_id !== eng.llm_id) return finish("aborted", `Agent's LLM changed from ${target.llm_id} to ${eng.llm_id} since it was verified. Re-verify the target. Nothing was changed.`);
  const llmId = eng.llm_id;
  const prot = await protectedLlmIds(d, r.stage);
  if (prot.error) return finish("aborted", `${prot.error}. Nothing was changed.`, { llm: llmId });
  if (prot.ids.has(llmId)) return finish("aborted", `Retell LLM ${llmId} is shared with ${prot.ids.get(llmId)}; writing it would change that agent too. Nothing was changed.`, { llm: llmId });
  const snap = await getRetellLlm({ apiKey: key, fetch: d.fetch, llmId });
  if (!snap.ok) return finish("aborted", `Reading current prompt: ${snap.error}. Nothing was changed.`, { llm: llmId });
  const snapText = typeof snap.body.general_prompt === "string" ? snap.body.general_prompt : "";
  const snapSha = await sha256Hex(snapText);
  const snapVer = typeof snap.body.version === "number" ? snap.body.version : null;
  const base = { llm: llmId, snapSha, snap: snapText.slice(0, 20_000), snapVer };
  if (current && snapSha !== current.prompt_sha256) {
    const msg = `Drift: the Retell prompt no longer matches v${current.seq} (edited outside the platform).`;
    if (r.kind === "deploy") return finish("aborted", `${msg} Review the snapshot on this deployment, then deploy again. Nothing was changed.`, base);
  }
  const up = await updateRetellLlmPrompt({ apiKey: key, fetch: d.fetch, llmId, generalPrompt: prompt });
  // Even when Retell reports an error (or the request timed out) the write may have applied: the read-back decides.
  const back = await getRetellLlm({ apiKey: key, fetch: d.fetch, llmId });
  const backText = back.ok && typeof back.body.general_prompt === "string" ? back.body.general_prompt : null;
  const backSha = backText === null ? null : await sha256Hex(backText);
  const verAfter = back.ok && typeof back.body.version === "number" ? back.body.version : null;
  const published = back.ok && typeof back.body.is_published === "boolean" ? back.body.is_published : null;
  if (backText === prompt) {
    const note = r.stage === "production"
      ? ` Retell draft updated${published ? "" : " (not published)"}: publish it in the Retell dashboard and confirm the phone number uses that version. Previous Retell version ${snapVer ?? "unknown"} is the rollback reference.`
      : "";
    return finish("verified", `Read-back matches v${v.seq} (prompt sha ${backSha!.slice(0, 12)}).${up.ok ? "" : ` Retell reported "${up.error}" but the read-back shows the update applied.`}${note}`, { ...base, readback: backSha!, verAfter, published });
  }
  if (!up.ok && backText === snapText) return finish("failed", `Updating prompt: ${up.error}. Read-back shows the previous prompt is unchanged.`, { ...base, readback: backSha ?? undefined, verAfter, published });
  // Read-back mismatch or failure: restore the snapshot so the agent is not left in an unknown state.
  const restore = await updateRetellLlmPrompt({ apiKey: key, fetch: d.fetch, llmId, generalPrompt: snapText });
  return finish("failed", `Read-back ${back.ok ? "did not match" : `failed (${back.error})`}; ${restore.ok ? "the previous prompt was restored" : `restoring the previous prompt ALSO FAILED (${restore.error}) — check the agent in Retell now`}.`, { ...base, readback: backSha ?? undefined, verAfter, published });
}

/** Known-good version for a stage: the most recent verified/superseded deployment of a version other than the current one. */
export async function rollbackCandidate(db: Db, stage: Stage): Promise<string | null> {
  const cur = await deployedVersion(db, stage);
  const row = await db.prepare(`SELECT version_id FROM so_deployments WHERE stage = ? AND status IN ('verified','superseded') AND version_id <> ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .bind(stage, cur?.id ?? "").first<{ version_id: string }>();
  return row?.version_id ?? null;
}

export async function rollback(d: DeployDeps, stage: Stage, userId: string | null, reason: string, toVersionId?: string): Promise<DeployResult> {
  const cur = await deployedVersion(d.db, stage);
  if (!cur) throw new SalesOptError(`Nothing is deployed on ${stage}.`, 409);
  const target = toVersionId ?? await rollbackCandidate(d.db, stage);
  if (!target) throw new SalesOptError(`There is no earlier verified version on ${stage} to roll back to.`, 409);
  const ok = await d.db.prepare(`SELECT 1 AS x FROM so_deployments WHERE stage = ? AND version_id = ? AND status IN ('verified','superseded')`).bind(stage, target).first();
  if (!ok) throw new SalesOptError("Roll back only to a version that was previously verified on this stage.", 409);
  const res = await deploy(d, { stage, versionId: target, expectedCurrentVersionId: cur.id, kind: "rollback", userId, reason });
  if (res.status === "verified") {
    await d.db.prepare(`UPDATE so_deployments SET status = 'rolled_back' WHERE stage = ? AND version_id = ? AND status = 'superseded' AND id = (SELECT id FROM so_deployments WHERE stage = ? AND version_id = ? AND status = 'superseded' ORDER BY created_at DESC LIMIT 1)`)
      .bind(stage, cur.id, stage, cur.id).run();
  }
  return res;
}
