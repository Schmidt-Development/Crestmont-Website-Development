// Route security matrix, part 3: exhaustive route-by-route audit inventory (EMP-002). Every
// authenticated state-changing route — and every data export — is classified in
// tests/support/route-inventory.ts as audited (with the exact action), non-sensitive (with a reason), or
// blocked (sensitive but unable to succeed in this environment). Audited routes are proven here by
// performing the action for real and finding the audit_logs row it wrote, attributed to the actor.
// Every record created here is TEST DATA.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildWorld, type World } from "./support/security-world.ts";
import { classified, pathFor, appErrors, toLogin, toMfa } from "./support/security-helpers.ts";
import { auditScenarios, withFakeAi } from "./support/security-scenarios.ts";
import { ROUTE_INVENTORY, type AuditClass } from "./support/route-inventory.ts";
import type { SqliteDb } from "../dev/sqlite-d1.ts";

let w: World;
let restoreFetch: () => void;
before(async () => { w = await buildWorld(); restoreFetch = withFakeAi(w); });
after(() => restoreFetch?.());

const auditClass = (key: string): AuditClass | undefined => ROUTE_INVENTORY[key]?.audit;
const flashOf = (res: Response) => {
  const c = res.headers.getSetCookie().find((x) => x.startsWith("cm_flash="));
  if (!c) return null;
  try { return JSON.parse(decodeURIComponent(c.slice("cm_flash=".length).split(";")[0])) as { kind: string; text: string }; } catch { return null; }
};
const maxAuditId = () => ((w.db as SqliteDb).raw.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM audit_logs`).get() as { n: number }).n;
const auditSince = (id: number) => (w.db as SqliteDb).raw.prepare(`SELECT action, actor_user_id, actor_kind, subject_type, subject_id FROM audit_logs WHERE id > ? ORDER BY id`).all(id) as { action: string; actor_user_id: string | null; actor_kind: string; subject_type: string; subject_id: string | null }[];

/** Sensitive categories (money, roles/permissions, user state, files, legal, releases, settings, deletions, exports). */
const SENSITIVE = /refund|pric|invoice|billing|payment|checkout|cost|role|employee|invit|disable|enable|privacy|password|session|mfa|file|share|delete|cancel|agreement|accept|approv|release|deploy|publish|settings|retention|suppression|export|\.csv|\.json|\.md|team|decide|issue/;

test("[EMP-002] audit inventory: every authenticated state-changing route and every export is classified; non-sensitive exemptions are justified", () => {
  const problems: string[] = [];
  for (const r of classified()) {
    const a = r.spec.audit;
    const authenticated = ["session", "customer", "staff"].includes(r.spec.access.kind);
    const isExport = r.method === "GET" && /export|\.csv$|\.json$|\.md$|\/reports\/:file|\/html$|\/pdf$/.test(r.pattern) && !/templates/.test(r.pattern);
    if (authenticated && (r.method === "POST" || isExport) && !a) problems.push(`${r.key}: no audit classification`);
    if (a && "exempt" in a) {
      if (a.exempt.length < 30) problems.push(`${r.key}: exemption reason too short`);
      if (SENSITIVE.test(r.pattern) && !/notifications|sweep/.test(r.pattern)) problems.push(`${r.key}: sensitive route classified as exempt (${a.exempt})`);
    }
  }
  assert.deepEqual(problems, []);
  const counts = { audited: 0, exempt: 0, blocked: 0 };
  for (const r of classified()) { const a = r.spec.audit; if (a) counts["action" in a ? "audited" : "exempt" in a ? "exempt" : "blocked"]++; }
  assert.ok(counts.audited >= 135, JSON.stringify(counts));
});

test("[EMP-002] every audited route writes its audit_logs action, attributed to the acting user, when it succeeds (performed for real)", async () => {
  const scenarios = auditScenarios(w);
  const audited = classified().filter((r) => { const a = r.spec.audit; return !!a && ("action" in a || "blocked" in a); }).map((r) => r.key);
  const keys = scenarios.map((s) => s.key);
  // Every audited or blocked route has a scenario (the inventory and the proof stay in step), and vice versa.
  assert.deepEqual(audited.filter((k) => !keys.includes(k)).sort(), [], "audited routes without a proving scenario");
  assert.deepEqual(keys.filter((k) => !audited.includes(k)), [], "scenarios for routes not classified as audited");
  const errors0 = appErrors(w.db);
  const problems: string[] = [];
  let proven = 0;
  for (const s of scenarios) {
    const cls = auditClass(s.key)!;
    const [method, pattern] = s.key.split(" ");
    const before = maxAuditId();
    let res: Response, actorId: string;
    try {
      await s.setup?.(w);
      if (s.run) ({ res, actorId } = await s.run(w));
      else {
        const who = s.as?.(w) ?? w.staff.owner;
        actorId = who.id;
        const path = s.path?.(w) ?? pathFor(w, { method, pattern, key: s.key, spec: ROUTE_INVENTORY[s.key] }, w.a);
        res = method === "GET" ? await who.c.get(path) : await who.c.post(path, s.fields?.(w) ?? {});
      }
    } catch (e) { problems.push(`${s.key}: scenario threw ${(e as Error).message}`); continue; }
    const flash = flashOf(res);
    const succeeded = [200, 201, 303].includes(res.status) && !toLogin(res) && !toMfa(res) && (flash?.kind !== "error" || !!s.allowErrorFlash);
    const rows = auditSince(before);
    if ("blocked" in cls) {
      if (succeeded) problems.push(`${s.key}: classified blocked but succeeded (${res.status}) — prove its audit action instead`);
      continue;
    }
    if (!succeeded) { problems.push(`${s.key}: did not succeed → ${res.status} ${res.headers.get("location") ?? ""} ${flash?.text ?? (await res.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 200)}`); continue; }
    const want = (cls as { action: string }).action;
    const hit = rows.find((r) => r.action === want);
    if (!hit) { problems.push(`${s.key}: expected audit action ${want}, wrote [${rows.map((r) => r.action).join(", ")}]`); continue; }
    if (hit.actor_user_id !== actorId) problems.push(`${s.key}: ${want} attributed to ${hit.actor_user_id}, expected ${actorId}`);
    proven++;
  }
  assert.deepEqual(problems, []);
  assert.ok(proven >= 135, `proved ${proven} audited routes`);
  assert.equal(appErrors(w.db), errors0, "no scenario produced a server error");
  // Exports selected by a query parameter on a page route are audited too.
  for (const p of ["/staff/finance/reconciliation?format=csv"]) {
    const before = maxAuditId();
    const res = await w.staff.owner.c.get(p);
    assert.match(res.headers.get("content-type") ?? "", /text\/csv/, p);
    assert.ok(auditSince(before).some((r) => r.action === "finance.exported" && r.actor_user_id === w.staff.owner.id), `${p} is audited`);
  }
  // The audit log stays append-only throughout.
  await assert.rejects(w.db.prepare(`UPDATE audit_logs SET action = 'tampered'`).run(), /append-only/);
});
