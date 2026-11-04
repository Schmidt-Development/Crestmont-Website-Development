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
import { certified, judgeFullHour, judgeSustained, type Outcome } from "../src/domain/promotion-certification.ts";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const MINUTES = Math.max(1, Math.min(Number(arg("minutes", "60")), 1440));
const TARGET = Math.max(1, Number(arg("target", String(TARGET_PER_MINUTE))));
const OUT = arg("out", "evidence")!;

const d1 = wranglerOps();
const q = <T = Record<string, unknown>>(sql: string) => d1.query<T>(sql);
const one = async (sql: string) => Number((await q<{ n: number }>(sql))[0]?.n ?? 0);
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

// Three outcomes, not two. "blocked" is a check that could not be attempted — almost always for want of eligible
// supply — and it is NOT a pass: a full hour must never be certified from a window that did not last an hour. It is
// reported separately from "fail" so a supply shortage is never read as a throughput defect, or the reverse.
type Check = { id: string; outcome: Outcome; detail: string };
const checks: Check[] = [];
const check = (id: string, outcome: Outcome | boolean, detail: string) => {
  const o: Outcome = outcome === true ? "pass" : outcome === false ? "fail" : outcome;
  checks.push({ id, outcome: o, detail });
  console.log(`${o === "pass" ? "PASS" : o === "blocked" ? "BLOCKED" : "FAIL"} ${id} — ${detail}`);
};

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
// Only leads created by the UNATTENDED scheduled promoter count towards the target. `decided_by` is the acting
// user's id, and the scheduled run's actor (RESEARCH_AUTOMATION) has none, so `decided_by IS NULL` is exactly the
// set promoted without a person asking. An Owner reconcile, a single-prospect Owner promotion and the promotions
// the staging deploy's own E2E performs all carry the Owner's id and are therefore excluded — none of them is
// evidence that the schedule works on its own, which is the only thing worth certifying.
const leadRows = await q<{ created_at: string }>(
  `SELECT l.created_at FROM leads l JOIN research_prospects p ON p.crm_lead_id = l.id
    WHERE l.origin = 'research_agent' AND l.created_at >= ${lit(since)} AND p.status = 'promoted' AND p.decided_by IS NULL
    ORDER BY l.created_at`);
const attendedLeads = await one(`SELECT COUNT(*) AS n FROM leads l JOIN research_prospects p ON p.crm_lead_id = l.id
  WHERE l.origin = 'research_agent' AND l.created_at >= ${lit(since)} AND p.status = 'promoted' AND p.decided_by IS NOT NULL`);
const allResearchLeads = await one(`SELECT COUNT(*) AS n FROM leads WHERE origin = 'research_agent' AND created_at >= ${lit(since)}`);
const ownerRunsInWindow = await one(`SELECT COUNT(*) AS n FROM research_promotion_runs WHERE started_at >= ${lit(since)} AND trigger <> 'scheduled'`);
check("attribution.unattended_only", true,
  `${leadRows.length} of ${allResearchLeads} new research leads in the window were created by the unattended schedule; `
  + `${attendedLeads} were promoted by a person (${ownerRunsInWindow} non-scheduled runs) and are excluded from every rate below`);
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

// A THROUGHPUT measurement, supply-adjusted: the mean over the minutes when there was work. It is deliberately NOT
// the hour certification below — a high mean over a short supplied stretch says the machine is fast enough, and
// says nothing about an hour.
check("throughput.supply_adjusted", workingLeads >= TARGET * workingMinutes,
  `${workingLeads} unattended leads over ${judged} = ${mean.toFixed(1)}/minute (needs ${TARGET * workingMinutes} over that stretch). Throughput only — not an hour certification.`);

// Sustained means minute by minute. There is no average fallback: a single burst of 300 in one minute followed by
// 59 idle minutes averages 5/minute and would once have satisfied an "or the average is fine" clause, which is
// exactly the claim the target is not making. Each working minute has to stand on its own.
// Every minute of the measured window, so a minute with no leads counts as the zero it is rather than being absent.
const allMinuteKeys: string[] = [];
for (let i = 0; i < MINUTES; i++) allMinuteKeys.push(new Date(Date.parse(since) + i * 60_000).toISOString().slice(0, 16));
const everyMinute = allMinuteKeys.map((k) => ({ minute: k, leads: perMinute.get(k) ?? 0 }));
const perWorkingMinute = everyMinute.slice(0, workingMinutes);

const sustained = judgeSustained(perWorkingMinute, TARGET);
check("rate.sustained", sustained.outcome,
  `${sustained.atTarget} of ${workingMinutes} working minutes individually reached ${TARGET}+ (needs ${sustained.needed}, i.e. 90%; no window average can substitute)`
  + (sustained.worst.length ? `; worst: ${sustained.worst.map((m) => `${m.minute.slice(11)}Z=${m.leads}`).join(", ")}` : ""));

const hour = judgeFullHour({ windowMinutes: MINUTES, workingMinutes, minutes: everyMinute, target: TARGET, drainedAt });
check("certification.full_hour", hour.outcome, hour.reason + (hour.outcome === "blocked" ? " See throughput.supply_adjusted for what the rate was over the minutes that did have work." : ""));

// ── 4. Every lead is a usable sales record ──
const bad = await one(`SELECT COUNT(*) AS n FROM leads l JOIN research_prospects p ON p.crm_lead_id = l.id
  WHERE l.origin = 'research_agent' AND l.created_at >= ${lit(since)} AND p.status = 'promoted' AND p.decided_by IS NULL
    AND (l.stage <> 'new' OR l.intake_decision_id IS NULL OR COALESCE(l.utm_source,'') <> 'crestmont-research'
      OR (p.website_class IN ('VERIFIED_WEBSITE_BROKEN','VERIFIED_WEBSITE_ISSUES','VERIFIED_OFFICIAL_WEBSITE') AND COALESCE(p.website_url,'') = ''))`);
check("leads.usable", bad === 0, `${bad} of the unattended new leads are not in stage new, lack an intake decision, lack research attribution, or lost a verified website`);

const withContact = await one(`SELECT COUNT(*) AS n FROM leads l
  JOIN research_prospects p ON p.crm_lead_id = l.id JOIN contacts c ON c.id = l.contact_id
  WHERE l.origin = 'research_agent' AND l.created_at >= ${lit(since)} AND p.status = 'promoted' AND p.decided_by IS NULL`);
check("leads.have_contact", withContact === total, `${withContact} of ${total} unattended new leads resolve to a contact row`);

const withEvidence = await one(`SELECT COUNT(*) AS n FROM leads l JOIN research_prospects p ON p.crm_lead_id = l.id
  WHERE l.origin = 'research_agent' AND l.created_at >= ${lit(since)} AND p.status = 'promoted' AND p.decided_by IS NULL
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
    JOIN research_prospects p ON p.crm_lead_id = l.id
  WHERE l.origin = 'research_agent' AND l.created_at >= ${lit(since)} AND ci.kind = 'phone'
    AND p.status = 'promoted' AND p.decided_by IS NULL
  GROUP BY ci.value_norm HAVING COUNT(DISTINCT l.id) > 1)`).catch(() => -1);
check("dedup.no_two_leads_on_one_number", dupPhones === 0,
  dupPhones < 0 ? "could not be read (the identity tables answered with an error)" : `${dupPhones} phone numbers reach more than one of the new leads`);

const callable = await one(`SELECT COUNT(*) AS n FROM research_prospects WHERE status = 'promoted' AND eligibility = 'eligible'`);
check("compliance.nothing_released_for_calling", callable === 0, `${callable} promoted prospects are marked eligible for automated calling (must be 0 by design)`);

// ── 6. Counters versus rows ──
// Scheduled runs only, to match the rows being counted: comparing every run's tally against the unattended rows
// would disagree by exactly the Owner's own promotions and look like a defect.
const reported = await one(`SELECT COALESCE(SUM(promoted),0) AS n FROM research_promotion_runs WHERE started_at >= ${lit(since)} AND trigger = 'scheduled'`);
check("integrity.counters_match_rows", reported === total,
  `the scheduled runs report ${reported} new leads; the leads table holds ${total} promoted without a person${reported === total ? " (agree)" : " — a counter and the rows disagree"}`);

const failed = await one(`SELECT COALESCE(SUM(failed),0) AS n FROM research_promotion_runs WHERE started_at >= ${lit(since)} AND trigger = 'scheduled'`);
const locked = await one(`SELECT COUNT(*) AS n FROM research_promotion_runs WHERE started_at >= ${lit(since)} AND trigger = 'scheduled' AND stopped_reason = 'locked'`);
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

const passed = checks.filter((c) => c.outcome === "pass").length;
const failures = checks.filter((c) => c.outcome === "fail");
const blocked = checks.filter((c) => c.outcome === "blocked");
// Certified means every check passed. A blocked check is not a pass, so a run that could not be supplied for an
// hour reports NOT CERTIFIED and says which part was supply rather than throughput.
const failedChecks = failures.length + blocked.length;
const isCertified = certified(checks.map((c) => c.outcome));

const lines = [
  `# Research → CRM import rate: staging certification`,
  ``,
  `Window ${since} → ${now.toISOString()} (${MINUTES} min). Target ${TARGET} new leads/minute.`,
  `Counted from the CRM's own rows (leads.origin = 'research_agent'), not from the promoter's counters.`,
  ``,
  `## Result: ${isCertified ? "**CERTIFIED**" : `**NOT CERTIFIED** — ${failures.length} failed, ${blocked.length} could not be attempted`}`,
  ...checks.map((c) => `- ${c.outcome === "pass" ? "✅" : c.outcome === "blocked" ? "⚠️ could not be attempted" : "❌"} ${c.id} — ${c.detail}`),
  ...(blocked.length ? ["", `**${blocked.length} check(s) could not be attempted.** That is not a throughput result in either direction: it means the conditions the check needs did not exist, which for this system almost always means eligible supply ran out. The throughput figures above still stand on their own.`] : []),
  ``,
  `## Rate`,
  `- unattended new CRM leads in the window: **${total}** (${attendedLeads} more were promoted by a person and do not count)`,
  `- the target is judged over ${judged}${drainedAt ? ", because a drained backlog is the goal and a rate of zero with nothing left to do is not a shortfall" : ""}`,
  `- mean over those minutes: **${mean.toFixed(2)}/minute**, **${Math.round(mean * 60)}/hour**`,
  `- best single minute: **${best[1]}** (target ${TARGET})`,
  `- minutes individually at or above target: ${sustained.atTarget} of ${workingMinutes}`,
  `- best fully-supplied hour: ${hour.bestHour ? `${hour.bestHour.leads} leads from ${hour.bestHour.start}Z (target ${hour.needed})` : "none existed — see certification.full_hour"}`,
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
  total, mean, workingMinutes, workingLeads, drainedAt, bestMinute: { minute: best[0], leads: best[1] }, minutesAtTarget: sustained.atTarget,
  scheduledRuns: ticks.length, distinctMinutes, locked, failed, backlog, reported, writesPerLead, checks,
  unattendedLeads: total, attendedLeads, allResearchLeads, ownerRunsInWindow, perWorkingMinute,
  certified: isCertified, failed_checks: failures.map((c) => c.id), blocked_checks: blocked.map((c) => c.id),
}, null, 2));
writeFileSync(join(OUT, "research-promotion-certification.md"), `${text}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
for (const c of failures) console.log(`::error title=Promotion certification ${c.id}::${c.detail}`);
for (const c of blocked) console.log(`::warning title=Promotion certification ${c.id} could not be attempted::${c.detail}`);
console.log(`::notice title=Promotion certification::${passed} passed, ${failures.length} failed, ${blocked.length} not attempted — ${total} unattended CRM leads, ${mean.toFixed(1)}/minute over ${workingMinutes} supplied minutes`);
process.exit(failedChecks ? 1 : 0);
