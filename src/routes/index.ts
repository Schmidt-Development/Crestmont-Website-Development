// Route registry. Each product area owns one module; order matters only for overlapping paths.
import type { Router } from "../lib/router.ts";
import * as api from "./api.ts";
import * as auth from "./auth.ts";
import * as publicSite from "./public.ts";
import * as portal from "./portal.ts";
import * as crm from "./crm.ts";
import * as projects from "./projects.ts";
import * as support from "./support.ts";
import * as finance from "./finance.ts";
import * as owner from "./owner.ts";
import * as readiness from "./readiness.ts";
import * as platform from "./platform.ts";
import * as legal from "./legal.ts";
import * as hooks from "./hooks.ts";
import * as ops from "./ops.ts";
import * as notifications from "./notifications.ts";
import * as reportsOps from "./reports-ops.ts";
import * as portalMaintenance from "./portal-maintenance.ts";

export function registerAll(r: Router): void {
  // reportsOps precedes finance so /staff/reports/operations is not captured by /staff/reports/:file.
  for (const m of [api, auth, publicSite, portal, crm, projects, support, reportsOps, finance, owner, readiness, platform, legal, hooks, ops, notifications, portalMaintenance]) m.register(r);
}
