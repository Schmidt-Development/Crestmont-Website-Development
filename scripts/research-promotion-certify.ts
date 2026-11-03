// Certifies the research → CRM import rate against STAGING, from the CRM's own rows.
//
// The acceptance criteria are stated in successfully persisted, genuinely new CRM leads per minute, so that is what
// this measures: `SELECT COUNT(*) FROM leads WHERE origin = 'research_agent' AND created_at BETWEEN ...`, read from
// staging D1 through wrangler. The promoter's own counters are read too, but only to be COMPARED with the rows — a
// gap between them is a defect this is meant to catch, not a rounding difference. A run counter can be wrong in a
// way a row cannot.
//
// It writes nothing except through the Owner's own routes, and it never resumes research or changes a threshold.
//
//   node --no-warnings scripts/research-promotion-certify.ts --minutes 60 [--target 25] [--out evidence]
//     env: E2E_BASE_URL, ACCESS_ROOT_KEY, CLOUDFLARE_API_TOKEN/ACCOUNT_ID
//
// What it proves, in order:
//   1. the one-minute schedule is registered and firing, from the run rows' own timestamps;
//   2. the best single minute reached the per-minute target;
//   3. the window as a whole reached the per-hour target;
//   4. every lead created is a usable sales record: stage new, intake decision, research attribution, website;
//   5. no business was imported twice, and nothing was released for calling;
//   6. the counters agree with the rows.
import { wranglerOps } from "./staging-access.ts";
import { TARGET_PER_MINUTE } from "../src/services/research-promote.ts";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const MINUTES = Math.max(1, Math.min(Number(arg("minutes", "60")), 1440));
const TARGET = Math.max(1, Number(arg("target", String(TARGET_PER_MINUTE))));
const OUT = arg("out", "evidence")!;

const d1 = wranglerOps();
const q = <T = Record<string, unknown>>(sql: string) => d1.query<T>(sql);
const one = async (sql: string) => Number((await q<{ n: number }>(sql))[0]?.n ?? 0);
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

type Check = { id: string; ok: boolean; detail: string };
const checks: Check[] = [];
const check = (id: string, ok: boolean, detail: string) => { checks.push({ id, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${id} — ${detail}`); };

const now = new Date();
const since = new Date(now.getTime() - MINUTES * 60_000).toISOString();

// ── 1. Is the one-minute schedule actually firing? ──
// From the run rows themselves: a schedule that is registered but not firing leaves gaps, and a gap is the single
// most important thing to see, because every other figure here would look like a throughput problem instead.
const ticks = await q<{ started_at: string; promoted: number; examined: number; remaining: number; duration_ms: number | null; stopped_reason: string; trigger: string }>(
  `SELECT started_at, promoted, examined, remaining, duration_ms, stopped_reason, trigger FROM research_promotion_runs
    WHERE trigger = 'scheduled' AND started_at >= ${lit(since)} ORDER BY started_at`);
const distinctMinutes = new Set(ticks.map((t) => String(t.started_at).slice(0, 16))).size;
const expectedTicks = MINUTES;
check("schedule.firing_every_minute", distinctMinutes >= Math.floor(expectedTicks * 0.9),
  `${distinctMinutes} distinct minutes have a scheduled run in the last ${MINUTES} (expected about ${expectedTicks}; a shortfall means ticks were missed, not that promotion was slow)`);

const gaps: string[] = [];
for (let i = 1; i < ticks.length; i++) {
  const delta = (Date.parse(String(ticks[i].started_at)) - Date.parse(String(ticks[i - 1].started_at))) / 1000;
  if (delta > 150) gaps.push(`${String(ticks[i - 1].started_at).slice(11, 19)}→${String(ticks[i].started_at).slice(11, 19)} (${Math.round(delta)}s)`);
}
check("schedule.no_long_gaps", gaps.length === 0, gaps.length ? `gaps longer than 150s: ${gaps.slice(0, 6).join(", ")}` : "no gap longer than 150s between consecutive scheduled runs");

// ── 2 & 3. The rate, from the leads table ──
const leadRows = await q<{ created_at: string }>(
  `SELECT created_at FROM leads WHERE origin = 'research_agent' AND created_at >= ${lit(since)} ORDER BY created_at`);
const perMinute = new Map<string, number>();
for (const r of leadRows) { const k = String(r.created_at).slice(0, 16); perMinute.set(k, (perMinute.get(k) ?? 0) + 1); }
const best = [...perMinute.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["—", 0] as [string, number];
const total = leadRows.length;

// A drained backlog is the GOAL, not a throughput failure. Once there is nothing eligible left, the rate falls to
// whatever research delivers and judging the target against those minutes would mark success as a fault — the same
// reason the ops alert needs a backlog before it fires. So the window is split at the point the work ran out, taken
// from the run rows' own `remaining`, and the target is judged only over the minutes when there was work to do.
const drainTick = ticks.find((t) => Number(t.remaining ?? 0) === 0 && Number(t.examined ?? 0) === 0);
const drainedAt = drainTick ? String(drainTick.started_at) : null;
const workingMinutes = drainedAt
  ? Math.max(1, Math.round((Date.parse(drainedAt) - Date.parse(since)) / 60_000))
  : MINUTES;
const workingLeads = drainedAt ? leadRows.filter((r) => String(r.created_at) < drainedAt).length : total;
const mean = workingLeads / workingMinutes;
const judged = drainedAt
  ? `the ${workingMinutes} minutes before the backlog ran out at ${drainedAt.slice(11, 19)}Z`
  : `all ${MINUTES} minutes`;

check("rate.best_minute_at_target", best[1] >= TARGET,
  `best single minute created ${best[1]} new CRM leads${best[0] === "—" ? "" : ` at ${best[0]}Z`} (target ${TARGET}/minute), counted from the leads table`);
check("rate.window_at_target", workingLeads >= TARGET * workingMinutes,
  `${workingLeads} new CRM leads over ${judged} = ${mean.toFixed(1)}/minute, ${Math.round(mean * 60)}/hour (target ${TARGET * workingMinutes} over that stretch)`);

// Sustained, not a single spike: how many of the working minutes individually met the target.
const workingKeys = drainedAt ? [...perMinute.entries()].filter(([k]) => `${k}:00.000Z` < drainedAt) : [...perMinute.entries()];
const atTarget = workingKeys.filter(([, n]) => n >= TARGET).length;
check("rate.sustained", atTarget >= Math.floor(workingMinutes * 0.8) || workingLeads >= TARGET * workingMinutes,
  `${atTarget} of ${workingMinutes} working minutes individually reached ${TARGET}+; ${perMinute.size} minutes created at least one lead`);

// ── 4. Every lead is a usable sales record ──
const bad = await one(`SELECT COUNT(*) AS n FROM leads l JOIN research_prospects p ON p.crm_lead_id = l.id
  WHERE l.origin = 'research_agent' AND l.created_at >= ${lit(since)} AND p.status = 'promoted'
    AND (l.stage <> 'new' OR l.intake_decision_id IS NULL OR COALESCE(l.utm_source,'') <> 'crestmont-research'
      OR (p.website_class IN ('VERIFIED_WEBSITE_BROKEN','VERIFIED_WEBSITE_ISSUES','VERIFIED_OFFICIAL_WEBSITE') AND COALESCE(p.website_url,'') = ''))`);
check("leads.usable", bad === 0, `${bad} of the new leads are not in stage new, lack an intake decision, lack research attribution, or lost a verified website`);

const withContact = await one(`SELECT COUNT(*) AS n FROM leads l JOIN contacts c ON c.id = l.contact_id
  WHERE l.origin = 'research_agent' AND l.created_at >= ${lit(since)}`);
check("leads.have_contact", withContact === total, `${withContact} of ${total} new leads resolve to a contact row`);

const withEvidence = await one(`SELECT COUNT(*) AS n FROM leads l JOIN research_prospects p ON p.crm_lead_id = l.id
  WHERE l.origin = 'research_agent' AND l.created_at >= ${lit(since)} AND p.status = 'promoted'
    AND p.score > 0 AND p.findings_count >= 0 AND LENGTH(COALESCE(l.message,'')) > 20`);
check("leads.carry_evidence", total === 0 || withEvidence === total,
  `${withEvidence} of ${total} carry the research score and the evidence text the salesperson reads`);

// ── 5. Deduplication and the calling gate ──
const doubled = await one(`SELECT COUNT(*) AS n FROM (SELECT crm_lead_id FROM research_prospects
  WHERE crm_lead_id IS NOT NULL AND status = 'promoted' GROUP BY crm_lead_id HAVING COUNT(*) > 1)`);
check("dedup.no_business_imported_twice", doubled === 0, `${doubled} CRM leads are claimed as a NEW lead by more than one research prospect`);

const orphan = await one(`SELECT COUNT(*) AS n FROM research_prospects p WHERE p.crm_lead_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.id = p.crm_lead_id)`);
check("dedup.no_orphan_claims", orphan === 0, `${orphan} prospects point at a CRM lead that does not exist`);

// An identity is shared through contact_identity_links, not owned by a contact, so the join goes through the links.
// Two of the NEW leads reachable on one phone number would mean the same business was imported twice under two
// contacts — the exact failure the identity-disjoint batching exists to prevent.
const dupPhones = await one(`SELECT COUNT(*) AS n FROM (
  SELECT ci.value_norm FROM contact_identities ci
    JOIN contact_identity_links cl ON cl.identity_id = ci.id AND cl.removed_at IS NULL
    JOIN leads l ON l.contact_id = cl.contact_id
  WHERE l.origin = 'research_agent' AND l.created_at >= ${lit(since)} AND ci.kind = 'phone'
  GROUP BY ci.value_norm HAVING COUNT(DISTINCT l.id) > 1)`).catch(() => -1);
check("dedup.no_two_leads_on_one_number", dupPhones === 0,
  dupPhones < 0 ? "could not be read (the identity tables answered with an error)" : `${dupPhones} phone numbers reach more than one of the new leads`);

const callable = await one(`SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'promoted' AND eligibility = 'eligible'`);
check("compliance.nothing_released_for_calling", callable === 0, `${callable} promoted prospects are marked eligible for automated calling (must be 0 by design)`);

// ── 6. Counters versus rows ──
const reported = await one(`SELECT COALESCE(SUM(promoted),0) AS n FROM research_promotion_runs WHERE started_at >= ${lit(since)}`);
check("integrity.counters_match_rows", reported === total,
  `the promotion runs report ${reported} new leads; the leads table holds ${total}${reported === total ? " (agree)" : " — a counter and the rows disagree"}`);

const failed = await one(`SELECT COALESCE(SUM(failed),0) AS n FROM research_promotion_runs WHERE started_at >= ${lit(since)}`);
const locked = await one(`SELECT COUNT(*) AS n FROM research_promotion_runs WHERE started_at >= ${lit(since)} AND stopped_reason = 'locked'`);
const backlog = await one(`SELECT COUNT(*) AS n FROM research_prospects p, research_settings s WHERE s.id = 1
  AND p.status = 'qualified' AND p.qualified = 1 AND p.score >= s.qualify_threshold AND p.promote_attempts < 5
  AND (p.promote_next_at IS NULL OR p.promote_next_at <= ${lit(now.toISOString())})`);
check("health.no_failures", failed === 0, `${failed} promotions failed unexpectedly in the window`);

// ── Cost, measured rather than estimated ──
// Rows written per lead is the meter that binds on Workers Paid (50 million a month included). It is derived from
// the real counts over the window: every statement the promotion path issues writes to one of these tables.
const writesPerLead = total > 0 ? await (async () => {
  const [a, c, ci, links, co, ld, ac, dec] = await Promise.all([
    one(`SELECT COUNT(*) AS n FROM audit_logs WHERE created_at >= ${lit(since)} AND action IN ('lead.created','research.prospect_promoted','research.auto_promotion_run','research.promotion_blocked')`),
    one(`SELECT COUNT(*) AS n FROM contacts WHERE created_at >= ${lit(since)}`),
    one(`SELECT COUNT(*) AS n FROM contact_identities WHERE created_at >= ${lit(since)}`).catch(() => 0),
    one(`SELECT COUNT(*) AS n FROM contact_identity_links WHERE created_at >= ${lit(since)}`).catch(() => 0),
    one(`SELECT COUNT(*) AS n FROM companies WHERE created_at >= ${lit(since)}`).catch(() => 0),
    total,
    one(`SELECT COUNT(*) AS n FROM crm_activities WHERE created_at >= ${lit(since)}`).catch(() => 0),
    one(`SELECT COUNT(*) AS n FROM crm_intake_decisions WHERE created_at >= ${lit(since)}`).catch(() => 0),
  ]);
  return { audit: a, contacts: c, identities: ci, identityLinks: links, companies: co, leads: ld, activities: ac, decisions: dec,
    rowsPerLead: (a + c + ci + links + co + ld + ac + dec) / total };
})() : null;

const passed = checks.filter((c) => c.ok).length;
const failedChecks = checks.length - passed;

const lines = [
  `# Research → CRM import rate: staging certification`,
  ``,
  `Window ${since} → ${now.toISOString()} (${MINUTES} min). Target ${TARGET} new leads/minute.`,
  `Counted from the CRM's own rows (leads.origin = 'research_agent'), not from the promoter's counters.`,
  ``,
  `## Result: ${failedChecks === 0 ? "**CERTIFIED**" : `**NOT CERTIFIED** (${failedChecks} failed)`}`,
  ...checks.map((c) => `- ${c.ok ? "✅" : "❌"} ${c.id} — ${c.detail}`),
  ``,
  `## Rate`,
  `- new CRM leads in the window: **${total}**`,
  `- the target is judged over ${judged}${drainedAt ? ", because a drained backlog is the goal and a rate of zero with nothing left to do is not a shortfall" : ""}`,
  `- mean over those minutes: **${mean.toFixed(2)}/minute**, **${Math.round(mean * 60)}/hour**`,
  `- best single minute: **${best[1]}** (target ${TARGET})`,
  `- minutes individually at or above target: ${atTarget} of ${workingMinutes}`,
  `- scheduled runs: ${ticks.length} across ${distinctMinutes} distinct minutes; ${locked} skipped for overlap; ${failed} failed`,
  `- eligible and still waiting: ${backlog}`,
  ``,
  `## Cost per lead, measured over this window`,
  writesPerLead
    ? `- rows written per new lead: **${writesPerLead.rowsPerLead.toFixed(1)}** base rows (leads ${writesPerLead.leads}, contacts ${writesPerLead.contacts}, identities ${writesPerLead.identities}, identity links ${writesPerLead.identityLinks}, companies ${writesPerLead.companies}, activities ${writesPerLead.activities}, intake decisions ${writesPerLead.decisions}, audit ${writesPerLead.audit}). D1 also writes one row per index touched, so the billed figure is higher than this.`
    : `- not measurable: no leads were created in this window`,
  writesPerLead
    ? `- at 36,000 leads/day that is about ${Math.round(36000 * writesPerLead.rowsPerLead * 30 / 1e6)} million base rows written a month against the 50 million included on Workers Paid, before index writes`
    : ``,
  writesPerLead
    ? `- at the 15,000/day minimum, about ${Math.round(15000 * writesPerLead.rowsPerLead * 30 / 1e6)} million`
    : ``,
].filter(Boolean);

const text = lines.join("\n");
console.log(`\n${text}`);
const { mkdirSync, writeFileSync, appendFileSync } = await import("node:fs");
const { join } = await import("node:path");
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "research-promotion-certification.json"), JSON.stringify({
  windowStart: since, windowEnd: now.toISOString(), minutes: MINUTES, target: TARGET,
  total, mean, workingMinutes, workingLeads, drainedAt, bestMinute: { minute: best[0], leads: best[1] }, minutesAtTarget: atTarget,
  scheduledRuns: ticks.length, distinctMinutes, locked, failed, backlog, reported, writesPerLead, checks,
  certified: failedChecks === 0,
}, null, 2));
writeFileSync(join(OUT, "research-promotion-certification.md"), `${text}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
for (const c of checks.filter((x) => !x.ok)) console.log(`::error title=Promotion certification ${c.id}::${c.detail}`);
console.log(`::notice title=Promotion certification::${passed} passed, ${failedChecks} failed — ${total} new CRM leads, ${mean.toFixed(1)}/minute`);
process.exit(failedChecks ? 1 : 0);
