// Data access helpers over the D1 binding (env.DB). Every query is parameterized; no string-built SQL with input.
import { CONFIG } from "./config.js";

export const one = (db, sql, ...args) => db.prepare(sql).bind(...args).first();
export const all = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results ?? [];
export const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();

/** The request clock (tests inject env.NOW_ISO / env.now; production uses the real clock). */
export const nowMs = (env) => (typeof env.now === "function" ? env.now() : Date.now());
export const nowIso = (env) => new Date(nowMs(env)).toISOString();

/**
 * Seed the catalogue from business.config.json once per configuration version (idempotent; never overwrites what
 * the administrator changed later: rows are only inserted when missing).
 */
export async function ensureSeeded(env) {
  const db = env.DB;
  const version = String(CONFIG.version ?? 1);
  const seeded = await one(db, `SELECT value FROM schema_info WHERE key = 'config_seeded'`);
  if (seeded?.value === version) return;
  const at = nowIso(env);
  const stmts = [];
  (CONFIG.services ?? []).forEach((s, i) => stmts.push(db.prepare(`INSERT OR IGNORE INTO services (id, name, description, price_cents, price_note, duration_minutes, bookable, payable, active, position, updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)`)
    .bind(s.id, s.name, s.description ?? "", s.priceCents ?? null, s.priceNote ?? null, s.durationMinutes ?? null, s.bookable ? 1 : 0, s.payable ? 1 : 0, i, at)));
  for (const r of CONFIG.booking?.resources ?? []) {
    stmts.push(db.prepare(`INSERT OR IGNORE INTO resources (id, name, capacity, active) VALUES (?,?,?,1)`).bind(r.id, r.name, r.capacity ?? 1));
    for (const sid of r.services ?? (CONFIG.services ?? []).filter((s) => s.bookable).map((s) => s.id)) stmts.push(db.prepare(`INSERT OR IGNORE INTO resource_services (resource_id, service_id) VALUES (?,?)`).bind(r.id, sid));
  }
  stmts.push(db.prepare(`INSERT INTO schema_info (key, value) VALUES ('config_seeded', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(version));
  await db.batch(stmts);
}

/** Effective settings: administrator overrides on top of the configuration defaults. */
export async function settings(env) {
  const rows = await all(env.DB, `SELECT key, value_json FROM settings`);
  const o = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value_json)]));
  return {
    hours: o.hours ?? CONFIG.hours ?? {},
    blackoutDates: o.blackoutDates ?? CONFIG.booking?.blackoutDates ?? [],
    notifyEmail: o.notifyEmail ?? CONFIG.notifications?.businessEmail ?? CONFIG.business?.email ?? null,
  };
}

export async function audit(env, actor, action, subjectType = null, subjectId = null, detail = null) {
  await run(env.DB, `INSERT INTO audit_log (actor, action, subject_type, subject_id, detail_json, at) VALUES (?,?,?,?,?,?)`, actor, action, subjectType, subjectId, detail ? JSON.stringify(detail) : null, nowIso(env));
}
