// CRM identity privacy erasure (PR #50). Removes a person's phone numbers and email addresses from every CRM identity
// structure, including records that were never linked to a contact (held research candidates), without touching
// another business that shares the same identifier, and without deleting customer, payment, contract or order rows.
//
// Called by:
//   - src/services/privacy.ts processDeletion   (account holder deletion; employee.manage + step-up)
//   - src/services/voice-ops.ts eraseCallerData (receptionist caller erasure; voice.manage)
//   - POST /staff/crm/identity-erasure          (Owner only + step-up: e.g. a research-imported prospect who asks)
//
// What happens, in ONE atomic batch (safe to retry: a second run finds nothing left and changes nothing):
//   1. Subject contacts are anonymised ('Deleted contact', no email/phone). They are the contacts named by the caller
//      plus every NON-customer contact identified only by the person's identifiers. The 0048 trigger then removes their
//      identity links, field history and review items. Their leads keep stage/history but lose the person's message.
//   2. EXCLUSIVE identifiers (no remaining holder outside the subject) are deleted from contact_identities (with their
//      email campaign enrollments), and every held research candidate, review value and field-history value that
//      normalizes to them is deleted or scrubbed, wherever it is attached.
//   3. SHARED identifiers (still used by another business, e.g. a receptionist line) stay with that business.
//   4. Optionally a salted-hash tombstone per exclusive identifier blocks automated re-import (migration 0049).
//   5. Suppression is preserved: voice_dnc and email_suppressions rows are kept (honouring an opt-out requires
//      remembering it); the phone outreach ledger keeps the number for per-number call limits (as calls already do).
// The audit entry holds counts only, never the identifiers.
import type { Db, DbStatement } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";
import { phoneKey, emailKey, RACE_GUARD, tombstoneHash } from "./contact-identity.ts";

export interface ErasureRequest {
  phones?: string[];
  emails?: string[];
  /** Contacts that belong to the person regardless of their identifiers (e.g. the account holder's own contacts). */
  contactIds?: string[];
  /** Leave salted-hash tombstones so automated imports cannot re-create the person. */
  blockReimport: boolean;
}
export interface ErasureResult {
  identifiers: number; exclusive: number; sharedKept: number; contacts: number; leadsScrubbed: number;
  reviewsDeleted: number; reviewsScrubbed: number; fieldChangesScrubbed: number; identitiesDeleted: number; enrollmentsDeleted: number; tombstones: number;
}
export class ErasureError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

type Key = { kind: "phone" | "email"; value: string };
const keyId = (k: Key) => `${k.kind}:${k.value}`;
const ph = (n: number) => Array.from({ length: n }, () => "?").join(",");
const ERASED = "[erased]";

async function chunked<T>(ids: string[], size: number, f: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(...await f(ids.slice(i, i + size)));
  return out;
}

/** Normalized identifiers mentioned by a stored value or held candidate. */
function keysIn(value: string | null): Set<string> {
  const out = new Set<string>();
  if (!value) return out;
  const p = phoneKey(value); if (p) out.add(`phone:${p}`);
  const e = emailKey(value); if (e) out.add(`email:${e}`);
  return out;
}
function keysInCandidate(json: string | null): Set<string> {
  const out = new Set<string>();
  if (!json) return out;
  try {
    const c = (JSON.parse(json) as { candidate?: { phones?: { value?: string }[]; emails?: { value?: string }[] } }).candidate ?? {};
    for (const p of c.phones ?? []) { const k = phoneKey(p.value); if (k) out.add(`phone:${k}`); }
    for (const e of c.emails ?? []) { const k = emailKey(e.value); if (k) out.add(`email:${k}`); }
  } catch { /* unparsable JSON is treated as mentioning nothing */ }
  return out;
}
/** Digits-only SQL view of a text column, so a phone pre-filter works whatever the stored formatting. */
const digitsSql = (col: string) => `replace(replace(replace(replace(replace(replace(replace(lower(COALESCE(${col},'')),' ',''),'-',''),'(',''),')',''),'.',''),'+',''),char(9),'')`;
/** Cheap SQL pre-filter for rows that might mention a key (emails: substring; phones: last 7 digits after removing
 *  separators). Exact matching happens afterwards on normalized values. Returns [sql, binds] for the given columns. */
function prefilter(keys: Key[], cols: string[]): [string, string[]] {
  const parts: string[] = [], binds: string[] = [];
  for (const k of keys) for (const c of cols) {
    if (k.kind === "email") { parts.push(`lower(COALESCE(${c},'')) LIKE ? ESCAPE '\\'`); binds.push(`%${k.value.replace(/[\\%_]/g, (m) => "\\" + m)}%`); }
    else { parts.push(`${digitsSql(c)} LIKE ?`); binds.push(`%${k.value.slice(-7)}%`); }
  }
  return [parts.join(" OR "), binds];
}

export async function eraseIdentityData(db: Db, actorUserId: string | null, req: ErasureRequest, opts: { action?: string; ip?: string | null; note?: string } = {}): Promise<ErasureResult> {
  for (let attempt = 0; ; attempt++) {
    try { return await eraseOnce(db, actorUserId, req, opts); }
    catch (e) {
      if (String((e as Error)?.message ?? e).includes(RACE_GUARD) && attempt < 4) continue; // a concurrent import linked an identifier: re-plan
      throw e;
    }
  }
}

async function eraseOnce(db: Db, actorUserId: string | null, req: ErasureRequest, opts: { action?: string; ip?: string | null; note?: string }): Promise<ErasureResult> {
  const at = nowIso();
  const keys = new Map<string, Key>();
  const addKey = (kind: "phone" | "email", raw: string | null | undefined) => { const v = kind === "phone" ? phoneKey(raw) : emailKey(raw); if (v) keys.set(`${kind}:${v}`, { kind, value: v }); };
  for (const p of req.phones ?? []) addKey("phone", p);
  for (const e of req.emails ?? []) addKey("email", e);
  const named = [...new Set(req.contactIds ?? [])];
  // Identifiers of the named contacts (current columns and every link, including history and additional numbers).
  if (named.length) {
    for (const r of await chunked(named, 80, async (c) => (await db.prepare(`SELECT email, phone FROM contacts WHERE id IN (${ph(c.length)})`).bind(...c).all<{ email: string | null; phone: string | null }>()).results)) { addKey("email", r.email); addKey("phone", r.phone); }
    for (const r of await chunked(named, 80, async (c) => (await db.prepare(`SELECT ci.kind, ci.value_norm FROM contact_identity_links l JOIN contact_identities ci ON ci.id = l.identity_id WHERE l.contact_id IN (${ph(c.length)})`).bind(...c).all<{ kind: "phone" | "email"; value_norm: string }>()).results)) keys.set(`${r.kind}:${r.value_norm}`, { kind: r.kind, value: r.value_norm });
  }
  if (!keys.size && !named.length) throw new ErasureError(422, "Give at least one valid phone number or email address.");
  // D1 allows 100 bound parameters per statement; the review pre-filter binds 3 per identifier.
  if (keys.size > 30) throw new ErasureError(422, "At most 30 identifiers per erasure.");

  // Who holds each identifier, and which holders are the person's own records. Expanded to a fixpoint: a contact that
  // becomes part of the subject contributes its other identifiers (they are erased only if no other business uses them).
  type Holder = { contact_id: string; identity_id: string; kind: "phone" | "email"; value_norm: string; customer: number; business: string };
  const holderRows = async (ks: Key[]): Promise<Holder[]> => {
    const out: Holder[] = [];
    for (let i = 0; i < ks.length; i += 40) {
      const c = ks.slice(i, i + 40);
      out.push(...(await db.prepare(`SELECT l.contact_id, ci.id AS identity_id, ci.kind, ci.value_norm,
          (c.user_id IS NOT NULL OR co.organization_id IS NOT NULL OR EXISTS (SELECT 1 FROM leads x WHERE x.contact_id = c.id AND (x.stage = 'converted' OR EXISTS (SELECT 1 FROM orders o WHERE o.lead_id = x.id)))) AS customer,
          COALESCE(co.domain_norm, lower(trim(co.name)), 'contact:' || c.id) AS business
        FROM contact_identities ci JOIN contact_identity_links l ON l.identity_id = ci.id AND l.removed_at IS NULL JOIN contacts c ON c.id = l.contact_id LEFT JOIN companies co ON co.id = c.company_id
        WHERE ${c.map(() => "(ci.kind = ? AND ci.value_norm = ?)").join(" OR ")}`).bind(...c.flatMap((k) => [k.kind, k.value])).all<Holder>()).results);
    }
    return out;
  };
  const subject = new Set(named);
  let holders: Holder[] = [];
  for (let round = 0; round < 5; round++) {
    holders = await holderRows([...keys.values()]);
    let grew = false;
    const byKey = new Map<string, Holder[]>();
    for (const h of holders) byKey.set(`${h.kind}:${h.value_norm}`, [...(byKey.get(`${h.kind}:${h.value_norm}`) ?? []), h]);
    for (const [, hs] of byKey) {
      const others = hs.filter((h) => !subject.has(h.contact_id));
      if (!others.length) continue;
      // One business across ALL holders (a contact without a company fits any business) and no customer among the
      // others: the identifier is the person's, and so are those records. Two businesses = a shared line/inbox: kept.
      const businesses = new Set(hs.map((h) => h.business).filter((b) => !b.startsWith("contact:")));
      if (businesses.size <= 1 && others.every((h) => !h.customer)) {
        for (const h of others) if (!subject.has(h.contact_id)) { subject.add(h.contact_id); grew = true; }
      }
    }
    if (!grew) break;
    for (const r of await chunked([...subject], 80, async (c) => (await db.prepare(`SELECT ci.kind, ci.value_norm FROM contact_identity_links l JOIN contact_identities ci ON ci.id = l.identity_id WHERE l.removed_at IS NULL AND l.contact_id IN (${ph(c.length)})`).bind(...c).all<{ kind: "phone" | "email"; value_norm: string }>()).results)) keys.set(`${r.kind}:${r.value_norm}`, { kind: r.kind, value: r.value_norm });
    if (keys.size > 30) throw new ErasureError(422, "These records carry more than 30 identifiers; erase them in parts or contact engineering.");
  }
  const keyList = [...keys.values()];
  const idRows = keyList.length ? (await db.prepare(`SELECT id, kind, value_norm FROM contact_identities WHERE ${keyList.map(() => "(kind = ? AND value_norm = ?)").join(" OR ")}`)
    .bind(...keyList.flatMap((k) => [k.kind, k.value])).all<{ id: string; kind: "phone" | "email"; value_norm: string }>()).results : [];
  const links = holders;
  const holdersByIdentity = new Map<string, Set<string>>();
  for (const l of links) holdersByIdentity.set(l.identity_id, new Set([...(holdersByIdentity.get(l.identity_id) ?? []), l.contact_id]));
  const exclusiveRows = idRows.filter((r) => [...(holdersByIdentity.get(r.id) ?? [])].every((c) => subject.has(c)));
  const exclusive = new Set([...exclusiveRows.map((r) => `${r.kind}:${r.value_norm}`), ...keyList.filter((k) => !idRows.some((r) => keyId(k) === `${r.kind}:${r.value_norm}`)).map(keyId)]);
  const exclusiveKeys = keyList.filter((k) => exclusive.has(keyId(k)));
  const subjectIds = [...subject];

  const stmts: DbStatement[] = [];
  // Race guard: commit only if nobody linked these identifiers since the plan (a concurrent import re-plans us).
  if (keyList.length) stmts.push(db.prepare(`INSERT INTO crm_write_guard (ok) SELECT 0 WHERE (SELECT COUNT(*) FROM contact_identity_links l JOIN contact_identities ci ON ci.id = l.identity_id
      WHERE l.removed_at IS NULL AND (${keyList.map(() => "(ci.kind = ? AND ci.value_norm = ?)").join(" OR ")})) <> ?`).bind(...keyList.flatMap((k) => [k.kind, k.value]), links.length));

  // 1. Subject contacts and the person's own text on their leads (stage, quotes, orders and history rows stay).
  let leadsScrubbed = 0;
  for (const chunk of Array.from({ length: Math.ceil(subjectIds.length / 80) }, (_, i) => subjectIds.slice(i * 80, i * 80 + 80))) {
    leadsScrubbed += (await db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE contact_id IN (${ph(chunk.length)}) AND message IS NOT NULL AND message <> 'Details erased at the person''s request'`).bind(...chunk).first<{ n: number }>())?.n ?? 0;
    stmts.push(db.prepare(`UPDATE leads SET message = 'Details erased at the person''s request' WHERE contact_id IN (${ph(chunk.length)}) AND message IS NOT NULL`).bind(...chunk));
    stmts.push(db.prepare(`UPDATE crm_activities SET body = 'Details erased at the person''s request' WHERE lead_id IN (SELECT id FROM leads WHERE contact_id IN (${ph(chunk.length)}))
        AND kind IN ('system','call') AND (body LIKE 'New % from this contact%' OR body LIKE '%Lead captured by AI receptionist%' OR body LIKE 'Matching % data received%')`).bind(...chunk));
    // The erased trigger (migration 0048) removes their identity links, field history and review items.
    stmts.push(db.prepare(`UPDATE contacts SET name = 'Deleted contact', email = NULL, phone = NULL WHERE id IN (${ph(chunk.length)})`).bind(...chunk));
  }

  // 2. Held candidates, review values and field history that mention an exclusive identifier, wherever they sit.
  let reviewsDeleted = 0, reviewsScrubbed = 0, fieldChangesScrubbed = 0;
  if (exclusiveKeys.length) {
    const [rw, rb] = prefilter(exclusiveKeys, ["candidate_json", "proposed_value", "current_value"]);
    const reviews = (await db.prepare(`SELECT id, contact_id, current_value, proposed_value, candidate_json FROM crm_identity_reviews WHERE ${rw} LIMIT 5000`).bind(...rb)
      .all<{ id: string; contact_id: string | null; current_value: string | null; proposed_value: string | null; candidate_json: string | null }>()).results;
    const hits = (s: Set<string>) => [...s].some((k) => exclusive.has(k));
    for (const r of reviews) {
      if (r.contact_id && subject.has(r.contact_id)) continue; // removed by the trigger with the contact
      const inCand = hits(keysInCandidate(r.candidate_json)), inProp = hits(keysIn(r.proposed_value)), inCur = hits(keysIn(r.current_value));
      if (!inCand && !inProp && !inCur) continue;
      if (!r.contact_id) { stmts.push(db.prepare(`DELETE FROM crm_identity_reviews WHERE id = ?`).bind(r.id)); reviewsDeleted++; continue; }
      // Attached to another (legitimate) record: keep the item for that record's audit trail, drop the person's data.
      stmts.push(db.prepare(`UPDATE crm_identity_reviews SET candidate_json = CASE WHEN ? THEN NULL ELSE candidate_json END,
          proposed_value = CASE WHEN ? THEN ? ELSE proposed_value END, current_value = CASE WHEN ? THEN ? ELSE current_value END,
          status = CASE WHEN status = 'open' THEN 'rejected' ELSE status END, resolved_at = COALESCE(resolved_at, ?), resolution_note = COALESCE(resolution_note, 'Erased at the data subject''s request') WHERE id = ?`)
        .bind(inCand ? 1 : 0, inProp ? 1 : 0, ERASED, inCur ? 1 : 0, ERASED, at, r.id));
      reviewsScrubbed++;
    }
    const [fw, fb] = prefilter(exclusiveKeys, ["old_value", "new_value"]);
    const changes = (await db.prepare(`SELECT id, contact_id, old_value, new_value FROM crm_field_changes WHERE ${fw} LIMIT 5000`).bind(...fb)
      .all<{ id: string; contact_id: string | null; old_value: string | null; new_value: string | null }>()).results;
    for (const f of changes) {
      if (f.contact_id && subject.has(f.contact_id)) continue;
      const o = hits(keysIn(f.old_value)), nv = hits(keysIn(f.new_value));
      if (!o && !nv) continue;
      stmts.push(db.prepare(`UPDATE crm_field_changes SET old_value = CASE WHEN ? THEN ? ELSE old_value END, new_value = CASE WHEN ? THEN ? ELSE new_value END WHERE id = ?`).bind(o ? 1 : 0, ERASED, nv ? 1 : 0, ERASED, f.id));
      fieldChangesScrubbed++;
    }
  }

  // 3. Exclusive identities (and their campaign enrollments). The phone ledger row keeps the number (call limits) and
  //    loses only its identity reference (ON DELETE SET NULL). Shared identities stay with the other business.
  const exclusiveIdentityIds = exclusiveRows.map((r) => r.id);
  let enrollmentsDeleted = 0;
  if (exclusiveIdentityIds.length) {
    enrollmentsDeleted = (await db.prepare(`SELECT COUNT(*) AS n FROM email_outreach_enrollments WHERE identity_id IN (${ph(exclusiveIdentityIds.length)})`).bind(...exclusiveIdentityIds).first<{ n: number }>())?.n ?? 0;
    stmts.push(db.prepare(`DELETE FROM email_outreach_enrollments WHERE identity_id IN (${ph(exclusiveIdentityIds.length)})`).bind(...exclusiveIdentityIds));
    // Links of subject contacts are removed by the trigger above (same batch, earlier); remaining history links of
    // already-erased contacts go here so the identity row can be deleted.
    stmts.push(db.prepare(`DELETE FROM contact_identity_links WHERE identity_id IN (${ph(exclusiveIdentityIds.length)})`).bind(...exclusiveIdentityIds));
    stmts.push(db.prepare(`DELETE FROM contact_identities WHERE id IN (${ph(exclusiveIdentityIds.length)})`).bind(...exclusiveIdentityIds));
  }

  // 4. Tombstones (exclusive identifiers only: a shared line must stay importable for the business that owns it).
  let tombstones = 0;
  if (req.blockReimport) for (const k of exclusiveKeys) {
    stmts.push(db.prepare(`INSERT INTO crm_erasure_tombstones (key_hash, kind, reason, created_at) VALUES (?, ?, 'erasure_request', ?) ON CONFLICT(key_hash) DO NOTHING`).bind(await tombstoneHash(k.kind, k.value), k.kind, at));
    tombstones++;
  }

  const result: ErasureResult = { identifiers: keyList.length, exclusive: exclusiveKeys.length, sharedKept: keyList.length - exclusiveKeys.length, contacts: subjectIds.length, leadsScrubbed,
    reviewsDeleted, reviewsScrubbed, fieldChangesScrubbed, identitiesDeleted: exclusiveIdentityIds.length, enrollmentsDeleted, tombstones };
  stmts.push(db.prepare(`INSERT INTO audit_logs (actor_user_id, actor_kind, action, subject_type, subject_id, details_json, ip, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(actorUserId, actorUserId ? "user" : "system", opts.action ?? "crm.identity_erased", "crm_identity", null, JSON.stringify({ ...result, blockReimport: req.blockReimport, ...(opts.note ? { note: opts.note.slice(0, 300) } : {}) }), opts.ip ?? null, at));
  await db.batch(stmts);
  return result;
}
