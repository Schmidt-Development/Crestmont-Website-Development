// DOCUMENTATION ONLY since READY-013 (2026-11-02). These records no longer set any readiness status.
//
// They used to be the source of truth for implementation status, asserted by hand. Nothing recomputed them
// when engineering work landed, so Launch Readiness drifted from reality: the 2026-11-02 audit found eleven
// merged-ready pull requests that moved the implemented count by zero, because none of them edited this
// directory. Status is now DERIVED from evidence:
//
//   requirements/acceptance.ts  — what proves each requirement (the acceptance criteria and its gates)
//   src/readiness/derive.ts     — the derivation: NOT_IMPLEMENTED → … → PRODUCTION_VERIFIED, BLOCKED, REGRESSED
//   src/readiness/sync.ts       — recalculation on every ingest, deployment and blocker change
//
// What survives here is the `location` and `owner` text: a useful pointer to where a requirement lives, shown
// on its dashboard page. syncRequirements still copies those two fields, and nothing else. Editing `status`
// below changes NOTHING on the dashboard — change the evidence, or the acceptance rule, instead.

export interface ImplementationRecord {
  status: "in_progress" | "implemented";
  location: string;
  owner: string;
  missing?: string;
}

import { FOUNDATION } from "./status/foundation.ts";
import { CORE } from "./status/core.ts";
import { PUBLIC_SITE } from "./status/public.ts";
import { PROJECTS } from "./status/projects.ts";
import { SALES_FINANCE } from "./status/sales-finance.ts";
import { SUPPORT_OWNER } from "./status/support-owner.ts";
import { PLATFORM } from "./status/platform.ts";
import { INTEGRATION } from "./status/integration.ts";
import { LEGAL_COMMERCE } from "./status/legal-commerce.ts";
import { INTEGRATIONS } from "./status/integrations.ts";
import { OPS } from "./status/ops.ts";
import { UX } from "./status/ux.ts";
import { SECURITY_MATRIX } from "./status/security-matrix.ts";
import { FINANCE_DOCS } from "./status/finance-docs.ts";
import { OWNER_MODULES } from "./status/owner-modules.ts";
import { BACKEND } from "./status/backend.ts";
import { E2E } from "./status/e2e.ts";
import { AI_BUILDS } from "./status/ai-builds.ts";
import { SALES_OPT } from "./status/sales-opt.ts";
import { REAUDIT_MISSING } from "./status/reaudit.ts";
import { CLOSURES, STARTED } from "./status/closeout.ts";

export const IMPLEMENTATION: Record<string, ImplementationRecord> = {
  ...FOUNDATION, ...CORE, ...PUBLIC_SITE, ...PROJECTS, ...SALES_FINANCE, ...SUPPORT_OWNER, ...PLATFORM, ...INTEGRATION, ...LEGAL_COMMERCE, ...INTEGRATIONS, ...OPS, ...UX, ...SECURITY_MATRIX, ...FINANCE_DOCS, ...OWNER_MODULES, ...E2E, ...BACKEND, ...AI_BUILDS, ...SALES_OPT,
};
for (const [id, missing] of Object.entries(REAUDIT_MISSING)) if (IMPLEMENTATION[id]?.status === "in_progress") IMPLEMENTATION[id] = { ...IMPLEMENTATION[id], missing };
for (const [id, rec] of Object.entries(STARTED)) if (IMPLEMENTATION[id]?.status !== "implemented") IMPLEMENTATION[id] = rec;
for (const c of CLOSURES) {
  const prev = IMPLEMENTATION[c.id];
  if (!prev) throw new Error(`closure for unknown record ${c.id}`);
  IMPLEMENTATION[c.id] = { status: "implemented", owner: prev.owner, location: `${prev.location} — closed 2026-10-27 on ${c.basis === "simulated-provider" ? "first-party + SIMULATED provider evidence" : "first-party evidence"}: ${c.evidence}${c.note ? ` (${c.note})` : ""}` };
}
