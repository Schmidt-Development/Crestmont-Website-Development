// Route registry. Each product area owns one module; order matters only for overlapping paths.
import { Router } from "../lib/router.ts";
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
import * as live from "./live.ts";
import * as builds from "./builds.ts";
import * as tax from "./tax.ts";
import * as testPayments from "./test-payments.ts";
import * as voiceOps from "./voice-ops.ts";
import * as accountProfile from "./account-profile.ts";
import * as salesOptimization from "./sales-optimization.ts";
import * as salesOutbound from "./sales-outbound.ts";
import * as research from "./research.ts";

export function registerAll(r: Router): void {
  // reportsOps precedes finance so /staff/reports/operations is not captured by /staff/reports/:file.
  for (const m of [api, auth, publicSite, portal, crm, projects, support, reportsOps, finance, owner, readiness, platform, legal, hooks, ops, notifications, portalMaintenance, live, builds, tax, voiceOps, salesOptimization, accountProfile, research, testPayments, salesOutbound]) m.register(r);
}

/** Every registered method + path pattern, in match order (route security matrix, AUTH-007/SEC-001). */
export function listRoutes(): { method: string; pattern: string }[] {
  return routeTable().list();
}

/** A fully registered router, for introspection (which pattern a concrete path resolves to). */
export function routeTable(): Router {
  const r = new Router();
  registerAll(r);
  return r;
}
