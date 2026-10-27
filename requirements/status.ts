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

export const IMPLEMENTATION: Record<string, ImplementationRecord> = {
  ...FOUNDATION, ...CORE, ...PUBLIC_SITE, ...PROJECTS, ...SALES_FINANCE, ...SUPPORT_OWNER, ...PLATFORM,
};
