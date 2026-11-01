// Test support: a scorecard as an eligible full-stack build reports it (FIXTURE). The lifecycle tests that are about
// leases, previews, revisions, releases etc. attach it to their ready_for_review completions so they keep testing
// what they were written for; the quality engine's own rules (missing, invalid or < 10/10 scorecards refused) are
// tested in tests/build-quality.test.ts.
import { QUALITY_CRITERIA } from "../../src/domain/quality.ts";

export function passingScorecard(o: { booking?: boolean; payments?: boolean; iteration?: number } = {}) {
  return {
    schema: "crestmont.quality-scorecard/1", packageId: "fixture", iteration: o.iteration ?? 1,
    criteria: QUALITY_CRITERIA.map((id) => {
      const applicable = !((id === "workflows" && !o.booking) || (id === "payments" && !o.payments));
      return { id, name: id, applicable, status: applicable ? "pass" : "not_applicable", evidence: applicable ? [`fixture evidence for ${id}`] : [], reason: null };
    }),
    score: 10, eligible: true, waitingExternal: false, defects: [], computedAt: new Date().toISOString(),
  };
}

/** Adds the passing scorecard to a ready_for_review completion that carries none. */
export function withQuality<T>(path: string, body: T): T {
  const b = body as Record<string, unknown>;
  if (path === "complete" && b && b.outcome === "ready_for_review" && b.quality === undefined) return { ...b, quality: passingScorecard() } as T;
  return body;
}
