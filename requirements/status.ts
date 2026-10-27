// Explicit implementation records (READY-002). Passing tests never promote a requirement to
// "implemented" on their own: a requirement is implemented only when every applicable layer in
// §3 exists. Partial work is "in_progress" with a note of what is missing.
//
// Each product area owns one file in requirements/status/. Later files override earlier ones
// for the same requirement id, so an area can upgrade a foundation record when it finishes it.

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

export const IMPLEMENTATION: Record<string, ImplementationRecord> = {
  ...FOUNDATION, ...CORE, ...PUBLIC_SITE, ...PROJECTS, ...SALES_FINANCE, ...SUPPORT_OWNER, ...PLATFORM, ...INTEGRATION, ...LEGAL_COMMERCE, ...INTEGRATIONS, ...OPS, ...UX, ...SECURITY_MATRIX, ...FINANCE_DOCS, ...OWNER_MODULES, ...E2E, ...BACKEND,
};
