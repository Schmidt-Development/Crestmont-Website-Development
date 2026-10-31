// Sales-optimization metrics (SALESOPT-004). Every figure comes from stored facts: so_call_facts (Retell events),
// so_attributions (webhook-verified payments), so_findings (grounded analysis) and calls.cost_microusd (Retell cost).
// Unknown is shown as unknown (null), never as zero. Test calls are excluded everywhere.
// Findings are counted per CALL (compliance, complaints) or per call and category (objections), so re-analysis with a
// new analyzer version, or a deterministic and a model finding for the same utterance, never count twice.
import type { Db } from "../../lib/db.ts";
import { COMPLIANCE_CATEGORIES } from "../../domain/sales-opt/analysis.ts";
import { rate, wilson, type Interval, type SafetyCounts } from "../../domain/sales-opt/stats.ts";

export interface MetricsFilter { stage?: "staging" | "production"; from: string; to: string; versionId?: string | null; segment?: string | null; experimentId?: string | null; arm?: "baseline" | "candidate" | null }

export interface Metrics {
  attempts: number; connected: number; qualified: number; checkoutInitiated: number; sales: number; revenueCents: number;
  refundsOrDisputes: number; optOuts: number; escalations: number; errors: number; complaints: number; analysed: number; complianceFindings: number;
  objections: number; avgDurationS: number | null; costMicroUsd: number | null; days: number;
  attemptsPerDay: number | null; connectionRate: number | null; qualifiedRate: number | null; conversionRate: number | null; conversionCi: Interval;
  revenuePerConnectedCents: number | null; revenuePerAttemptCents: number | null; checkoutCompletionRate: number | null; costPerAcquisitionMicroUsd: number | null;
  optOutRate: number | null; complaintRate: number | null; refundRate: number | null; complianceRate: number | null; objectionRate: number | null;
}

function where(f: MetricsFilter): { sql: string; binds: unknown[] } {
  const parts = ["f.is_test = 0", "f.last_event_rank >= 2", "COALESCE(f.ended_at, f.started_at) >= ?", "COALESCE(f.ended_at, f.started_at) < ?"];
  const binds: unknown[] = [f.from, f.to];
  if (f.stage) { parts.push("f.stage = ?"); binds.push(f.stage); }
  if (f.versionId !== undefined) { parts.push(f.versionId === null ? "f.version_id IS NULL" : "f.version_id = ?"); if (f.versionId !== null) binds.push(f.versionId); }
  if (f.segment) { parts.push("f.segment = ?"); binds.push(f.segment); }
  if (f.experimentId) { parts.push("f.experiment_id = ?"); binds.push(f.experimentId); }
  if (f.arm) { parts.push("f.arm = ?"); binds.push(f.arm); }
  return { sql: parts.join(" AND "), binds };
}

export async function computeMetrics(db: Db, f: MetricsFilter): Promise<Metrics> {
  const w = where(f);
  const c = (await db.prepare(`SELECT COUNT(*) AS attempts, COALESCE(SUM(f.connected = 1), 0) AS connected, COALESCE(SUM(f.qualified = 1), 0) AS qualified,
        COALESCE(SUM(f.checkout_link_generated), 0) AS checkout, COALESCE(SUM(f.opt_out), 0) AS opt_outs, COALESCE(SUM(f.human_escalation), 0) AS escalations,
        COALESCE(SUM(f.error IS NOT NULL), 0) AS errors, AVG(CASE WHEN f.connected = 1 THEN f.duration_ms END) AS avg_ms,
        SUM(c.cost_microusd) AS cost, COUNT(c.cost_microusd) AS costed
      FROM so_call_facts f JOIN calls c ON c.id = f.call_id WHERE ${w.sql}`).bind(...w.binds)
    .first<{ attempts: number; connected: number; qualified: number; checkout: number; opt_outs: number; escalations: number; errors: number; avg_ms: number | null; cost: number | null; costed: number }>())!;
  const s = (await db.prepare(`SELECT COALESCE(SUM(a.status = 'paid'), 0) AS sales, COALESCE(SUM(CASE WHEN a.status = 'paid' THEN a.amount_cents END), 0) AS revenue,
        COALESCE(SUM(a.status IN ('refunded','partially_refunded','disputed')), 0) AS bad, COUNT(*) AS total
      FROM so_attributions a JOIN so_call_facts f ON f.call_id = a.call_id WHERE a.is_last_touch = 1 AND ${w.sql}`).bind(...w.binds)
    .first<{ sales: number; revenue: number; bad: number; total: number }>())!;
  const fnd = (await db.prepare(`SELECT
        COUNT(DISTINCT CASE WHEN an.status = 'done' THEN an.call_id END) AS analysed,
        COUNT(DISTINCT CASE WHEN fi.basis = 'observed' AND fi.category IN (${[...COMPLIANCE_CATEGORIES].map(() => "?").join(",")}) THEN fi.call_id END) AS compliance,
        COUNT(DISTINCT CASE WHEN fi.category = 'complaint' THEN fi.call_id END) AS complaints,
        COUNT(DISTINCT CASE WHEN fi.category IN ('objection','pricing_resistance','trust_concern') THEN fi.call_id || ':' || fi.category END) AS objections
      FROM so_call_facts f JOIN so_analyses an ON an.call_id = f.call_id LEFT JOIN so_findings fi ON fi.analysis_id = an.id WHERE ${w.sql}`).bind(...COMPLIANCE_CATEGORIES, ...w.binds)
    .first<{ analysed: number; compliance: number; complaints: number; objections: number }>())!;
  const days = Math.max(1, Math.round((Date.parse(f.to) - Date.parse(f.from)) / 86_400_000));
  // Cost is known only when every attempt reported one; a partial sum would understate it.
  const cost = c.attempts > 0 && c.costed === c.attempts ? c.cost : null;
  return {
    attempts: c.attempts, connected: c.connected, qualified: c.qualified, checkoutInitiated: c.checkout, sales: s.sales, revenueCents: s.revenue,
    refundsOrDisputes: s.bad, optOuts: c.opt_outs, escalations: c.escalations, errors: c.errors, complaints: fnd.complaints, analysed: fnd.analysed,
    complianceFindings: fnd.compliance, objections: fnd.objections, avgDurationS: c.avg_ms === null ? null : Math.round(c.avg_ms / 1000), costMicroUsd: cost, days,
    attemptsPerDay: c.attempts ? c.attempts / days : null,
    connectionRate: rate(c.connected, c.attempts), qualifiedRate: rate(c.qualified, c.connected), conversionRate: rate(s.sales, c.connected), conversionCi: wilson(s.sales, c.connected),
    revenuePerConnectedCents: c.connected ? s.revenue / c.connected : null, revenuePerAttemptCents: c.attempts ? s.revenue / c.attempts : null,
    checkoutCompletionRate: rate(s.sales, c.checkout), costPerAcquisitionMicroUsd: cost !== null && s.sales > 0 ? cost / s.sales : null,
    optOutRate: rate(c.opt_outs, c.connected), complaintRate: rate(fnd.complaints, c.connected), refundRate: rate(s.bad, s.total),
    complianceRate: rate(fnd.compliance, fnd.analysed), objectionRate: rate(fnd.objections, c.connected),
  };
}

export function safetyCounts(m: Metrics): SafetyCounts {
  return { attempts: m.attempts, connected: m.connected, analysed: m.analysed, optOuts: m.optOuts, complianceFindings: m.complianceFindings, complaints: m.complaints, errors: m.errors, sales: m.sales, refundsOrDisputes: m.refundsOrDisputes };
}

export async function topFindings(db: Db, from: string, limit = 8): Promise<{ category: string; count: number; observed: number }[]> {
  return (await db.prepare(`SELECT fi.category, COUNT(*) AS count, COALESCE(SUM(fi.basis = 'observed'), 0) AS observed FROM so_findings fi JOIN so_call_facts f ON f.call_id = fi.call_id
      WHERE f.is_test = 0 AND fi.created_at >= ? GROUP BY fi.category ORDER BY count DESC LIMIT ?`).bind(from, limit).all<{ category: string; count: number; observed: number }>()).results;
}

export async function segmentBreakdown(db: Db, f: MetricsFilter): Promise<{ segment: string; metrics: Metrics }[]> {
  const w = where(f);
  const segs = (await db.prepare(`SELECT DISTINCT COALESCE(f.segment, '') AS s FROM so_call_facts f WHERE ${w.sql} LIMIT 20`).bind(...w.binds).all<{ s: string }>()).results;
  const out: { segment: string; metrics: Metrics }[] = [];
  for (const { s } of segs) if (s) out.push({ segment: s, metrics: await computeMetrics(db, { ...f, segment: s }) });
  return out;
}
