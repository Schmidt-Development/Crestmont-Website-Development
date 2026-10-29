// Legal holds (SEC-006, §65–§66; finding F-25). A hold suspends deletion of data that may be needed for a
// dispute, chargeback, security investigation, regulator request or litigation.
//
// Scopes:
//  - global: the retention job deletes nothing in the configurable tier and keeps expired/revoked sessions
//    (sign-in evidence). Privacy anonymisation is refused for everyone.
//  - organization: soft-deleted files of that organization are not purged; anonymising any member is refused.
//  - user: that user's security events and sessions are kept; anonymising that user is refused.
// Facts of a hold are immutable and holds are never deleted (triggers in migrations/0040); a release is
// recorded once, with who and why. Placing and releasing holds is an Owner decision, normally on counsel's advice.
// The Owner runs scripts/legal-hold.ts (same pattern as bootstrap-owner); there is no web form yet.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { audit } from "./security.ts";

export type HoldScope = "global" | "organization" | "user";
export interface LegalHoldRow { id: string; scope: HoldScope; subject_id: string | null; reason: string; matter_reference: string | null; placed_by: string | null; placed_at: string; released_at: string | null }

export class LegalHoldError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export async function placeHold(db: Db, input: { scope: HoldScope; subjectId?: string | null; reason: string; matterReference?: string | null; placedBy?: string | null }): Promise<string> {
  if (!["global", "organization", "user"].includes(input.scope)) throw new LegalHoldError("Unknown hold scope");
  const subject = input.scope === "global" ? null : (input.subjectId ?? "").trim();
  if (input.scope !== "global" && !subject) throw new LegalHoldError("A scoped hold needs the organization or user id");
  const reason = input.reason.trim();
  if (reason.length < 5) throw new LegalHoldError("Record why the hold is placed");
  if (input.scope === "organization" && !(await db.prepare(`SELECT 1 FROM organizations WHERE id = ?`).bind(subject).first())) throw new LegalHoldError("Organization not found", 404);
  if (input.scope === "user" && !(await db.prepare(`SELECT 1 FROM users WHERE id = ?`).bind(subject).first())) throw new LegalHoldError("User not found", 404);
  const id = newId("hold");
  await db.prepare(`INSERT INTO legal_holds (id, scope, subject_id, reason, matter_reference, placed_by, placed_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(id, input.scope, subject, reason.slice(0, 1000), input.matterReference?.slice(0, 200) ?? null, input.placedBy ?? null, nowIso()).run();
  await audit(db, { actorUserId: input.placedBy ?? null, actorKind: input.placedBy ? "user" : "system", action: "legal_hold.placed", subjectType: "legal_hold", subjectId: id,
    organizationId: input.scope === "organization" ? subject : null, details: { scope: input.scope, subjectId: subject, matter: input.matterReference ?? undefined } });
  return id;
}

export async function releaseHold(db: Db, id: string, input: { releasedBy?: string | null; note: string }): Promise<void> {
  if (input.note.trim().length < 5) throw new LegalHoldError("Record why the hold is released");
  const res = await db.prepare(`UPDATE legal_holds SET released_at = ?, released_by = ?, release_note = ? WHERE id = ? AND released_at IS NULL`)
    .bind(nowIso(), input.releasedBy ?? null, input.note.slice(0, 1000), id).run();
  if (res.meta.changes !== 1) throw new LegalHoldError("No active hold with that id", 404);
  await audit(db, { actorUserId: input.releasedBy ?? null, actorKind: input.releasedBy ? "user" : "system", action: "legal_hold.released", subjectType: "legal_hold", subjectId: id });
}

export interface ActiveHolds { global: boolean; organizations: Set<string>; users: Set<string>; count: number }

export async function activeHolds(db: Db): Promise<ActiveHolds> {
  let rows: { scope: HoldScope; subject_id: string | null }[] = [];
  try {
    rows = (await db.prepare(`SELECT scope, subject_id FROM legal_holds WHERE released_at IS NULL`).all<{ scope: HoldScope; subject_id: string | null }>()).results;
  } catch (e) {
    // Fail closed: if the hold register cannot be read (e.g. migration not applied), behave as if a global hold exists.
    if (/no such table/i.test(String((e as Error).message))) return { global: true, organizations: new Set(), users: new Set(), count: -1 };
    throw e;
  }
  return {
    global: rows.some((r) => r.scope === "global"),
    organizations: new Set(rows.filter((r) => r.scope === "organization").map((r) => r.subject_id!)),
    users: new Set(rows.filter((r) => r.scope === "user").map((r) => r.subject_id!)),
    count: rows.length,
  };
}

/** Why a user may not be anonymised right now, or null. Checks global, user and every organization they belong to. */
export async function holdBlockingUser(db: Db, userId: string): Promise<string | null> {
  const h = await activeHolds(db);
  if (h.global) return "A global legal hold is in place";
  if (h.users.has(userId)) return "This account is under a legal hold";
  if (h.organizations.size) {
    const orgs = (await db.prepare(`SELECT organization_id FROM memberships WHERE user_id = ?`).bind(userId).all<{ organization_id: string }>()).results;
    if (orgs.some((o) => h.organizations.has(o.organization_id))) return "An organization this account belongs to is under a legal hold";
  }
  return null;
}

export async function listHolds(db: Db, includeReleased = false): Promise<LegalHoldRow[]> {
  return (await db.prepare(`SELECT id, scope, subject_id, reason, matter_reference, placed_by, placed_at, released_at FROM legal_holds ${includeReleased ? "" : "WHERE released_at IS NULL"} ORDER BY placed_at DESC LIMIT 200`)
    .all<LegalHoldRow>()).results;
}

/** SQL list helper: a NOT IN clause and its binds for a set of ids (empty set → no restriction). */
export function notIn(column: string, ids: Set<string>): { sql: string; binds: string[] } {
  if (!ids.size) return { sql: "", binds: [] };
  return { sql: ` AND (${column} IS NULL OR ${column} NOT IN (${[...ids].map(() => "?").join(",")}))`, binds: [...ids] };
}
