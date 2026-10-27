// Shared helpers for the route security matrix tests (AUTH-007, AUTH-008, EMP-002, SEC-001).
import { createHash } from "node:crypto";
import { listRoutes } from "../../src/routes/index.ts";
import { ROUTE_INVENTORY, routeKey, type RouteSpec } from "./route-inventory.ts";
import { idFor, fillPath, type Tenant, type World } from "./security-world.ts";
import type { SqliteDb } from "../../dev/sqlite-d1.ts";
import type { Env } from "../../src/app/context.ts";
import type { TestClient } from "./app.ts";

export interface RouteEntry { method: string; pattern: string; key: string; spec: RouteSpec }

/** Every registered route joined with its inventory classification (undefined spec = unclassified). */
export function routes(): (RouteEntry & { spec: RouteSpec | undefined })[] {
  return listRoutes().map((r) => ({ ...r, key: routeKey(r.method, r.pattern), spec: ROUTE_INVENTORY[routeKey(r.method, r.pattern)] }));
}
export function classified(): RouteEntry[] {
  return routes().filter((r): r is RouteEntry => !!r.spec);
}

/** Concrete path for a route, substituting each :param with the id of that resource kind owned by `tenant`. */
export function pathFor(w: World, r: RouteEntry, tenant: Tenant = w.b): string {
  const params: Record<string, string> = {};
  for (const [name, kind] of Object.entries(r.spec.params ?? {})) params[name] = idFor(w, kind, tenant);
  const query = r.spec.query ? "?" + r.spec.query.replace(/\{([A-Za-z0-9]+)\}/g, (_, k) => encodeURIComponent(idFor(w, k as never, tenant))) : "";
  return fillPath(r.pattern, params) + query;
}

export async function call(c: TestClient, r: { method: string }, path: string, fields: Record<string, string | string[] | Blob | File> = {}): Promise<Response> {
  return r.method === "GET" ? c.get(path) : c.post(path, fields);
}

/** Tables whose rows legitimately change on denied requests (logging, rate limiting, session bookkeeping, request metrics). */
export const VOLATILE = new Set(["audit_logs", "security_events", "rate_limits", "app_errors", "sessions", "d1_migrations", "email_deliveries", "email_messages", "env_metrics"]);

/** Per-table content hash of the whole database (except volatile tables), to prove denied requests change nothing. */
export function snapshot(db: Env["DB"], exclude: Set<string> = VOLATILE): Map<string, string> {
  const raw = (db as SqliteDb).raw;
  const out = new Map<string, string>();
  const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map((t) => t.name);
  for (const t of tables) {
    if (exclude.has(t)) continue;
    const rows = raw.prepare(`SELECT * FROM "${t}"`).all();
    out.set(t, createHash("sha256").update(JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? String(v) : v))).digest("hex"));
  }
  return out;
}
export function changedTables(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after.keys()].filter((k) => before.get(k) !== after.get(k));
}

export const count = (db: Env["DB"], table: string) => ((db as SqliteDb).raw.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
export const appErrors = (db: Env["DB"]) => count(db, "app_errors");

export const loc = (res: Response) => res.headers.get("location") ?? "";
export const toLogin = (res: Response) => res.status === 303 && /^\/login(\?|$)/.test(loc(res));
export const toMfa = (res: Response) => res.status === 303 && /^\/mfa(\?|$|\/)/.test(loc(res));

/**
 * Tenant-consistency invariant: no row links records of two different customer organizations — neither a
 * row and a record it references, nor two records one row references (e.g. a task dependency between two
 * tenants' tasks). A row's organization is its organization_id, or its project's organization.
 */
export function crossTenantLinks(db: Env["DB"]): string[] {
  const raw = (db as SqliteDb).raw;
  const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]).map((t) => t.name);
  const cols = new Map(tables.map((t) => [t, new Set((raw.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name))]));
  const orgExpr = (t: string, alias: string): string | null =>
    t === "projects" ? `${alias}.organization_id`
      : cols.get(t)?.has("organization_id") ? `${alias}.organization_id`
      : cols.get(t)?.has("project_id") ? `(SELECT organization_id FROM projects WHERE id = ${alias}.project_id)` : null;
  const customer = (e: string) => `${e} IN (SELECT id FROM organizations WHERE kind = 'customer')`;
  const count = (sql: string) => (raw.prepare(sql).get() as { n: number }).n;
  const problems: string[] = [];
  for (const t of tables) {
    const fks = (raw.prepare(`PRAGMA foreign_key_list("${t}")`).all() as { table: string; from: string; to: string | null }[])
      .filter((fk) => fk.table !== "organizations" && orgExpr(fk.table, "y") !== null);
    const own = orgExpr(t, "x");
    for (const fk of fks) {
      // (A row whose organization is derived from its project trivially agrees with that project.)
      if (!own || (fk.from === "project_id" && !cols.get(t)?.has("organization_id"))) continue;
      const other = orgExpr(fk.table, "y")!;
      const n = count(`SELECT COUNT(*) AS n FROM "${t}" x JOIN "${fk.table}" y ON y."${fk.to ?? "id"}" = x."${fk.from}" WHERE ${own} <> ${other} AND ${customer(own)} AND ${customer(other)}`);
      if (n) problems.push(`${t}.${fk.from} → ${fk.table}: ${n} row(s) link two organizations`);
    }
    for (let i = 0; i < fks.length; i++) for (let j = i + 1; j < fks.length; j++) {
      const [f1, f2] = [fks[i], fks[j]];
      const o1 = orgExpr(f1.table, "y1")!, o2 = orgExpr(f2.table, "y2")!;
      const n = count(`SELECT COUNT(*) AS n FROM "${t}" x JOIN "${f1.table}" y1 ON y1."${f1.to ?? "id"}" = x."${f1.from}" JOIN "${f2.table}" y2 ON y2."${f2.to ?? "id"}" = x."${f2.from}" WHERE ${o1} <> ${o2} AND ${customer(o1)} AND ${customer(o2)}`);
      if (n) problems.push(`${t}: ${f1.from} and ${f2.from} reference two organizations in ${n} row(s)`);
    }
  }
  return problems;
}

/** Strings from `tenant` that must never appear in a response served to another tenant. */
export function leakedFrom(body: string, tenant: Tenant): string[] {
  const hits: string[] = [];
  if (body.includes(tenant.marker)) hits.push(tenant.marker);
  for (const id of tenant.allIds) if (body.includes(id)) hits.push(id);
  return hits;
}
