// Research-agent / CRM import API v1 (CRM-001, CRM-007). Contract: docs/crm-identity/IMPORT-API.md.
//
// The research engine sends candidate businesses; Crestmont alone decides what they are (contact-identity.ts intake).
// The engine never implements identity rules of its own. Properties:
//   authenticated   HMAC-SHA256 signature header (x-crestmont-signature: t=<unix>,v1=<hex>) with CRM_IMPORT_SECRET
//   versioned       body.apiVersion must equal IMPORT_API_VERSION; the URL carries the major version (/v1/)
//   idempotent      Idempotency-Key header per batch (same key + different body → 409) and a per-record key
//                   (<client>:<externalId>), so a retried or re-batched record never creates a second record
//   batch-capable   up to MAX_RECORDS (25) records per request (bounded by the D1 per-invocation query limit)
//   rate-controlled IMPORT_BATCHES_PER_HOUR per client
//   schema-validated per-record validation; invalid records are reported, valid ones still processed
//   provenance      source URL / observation date / confidence are kept on the decision and lead activity
//   retry-safe      a failed record reports retryable=true; resending the same batch only re-runs what failed
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { intake, previewMatches, IntakeError, type Candidate, type IntakeOutcome } from "./contact-identity.ts";

export const IMPORT_API_VERSION = "2026-10-30";
/**
 * Records per request. Measured locally (scripts/bench-crm-import.ts): ~15 statements per typical record; each extra
 * phone/email adds ~3, so a record with all 10 identifiers costs ~40. 25 records keeps even that worst case at the
 * 1,000 D1 queries per Worker invocation limit, and a typical batch near 375.
 */
export const MAX_RECORDS = 25;
/** 120 × 25 = 3,000 records/hour per client; the 10,000/day design target needs ~400 batches (~17/hour). */
export const IMPORT_BATCHES_PER_HOUR = 120;

const LABELS = ["main", "mobile", "office", "direct", "shared_line", "shared_inbox", "other"] as const;
const INTERESTS = ["starter", "business", "premium", "custom", "maintenance", "other"] as const;
const VERIFIABLE = ["contact_name", "business_name", "website"] as const;

export interface ImportRecord {
  externalId: string;
  business: { name: string; website?: string; location?: { city?: string; region?: string; postalCode?: string } };
  contact?: { name?: string };
  phones?: { value: string; label?: (typeof LABELS)[number]; verified?: boolean }[];
  emails?: { value: string; label?: (typeof LABELS)[number]; verified?: boolean }[];
  verifiedFields?: (typeof VERIFIABLE)[number][];
  confidence?: number;
  interest?: (typeof INTERESTS)[number];
  evidence?: { sourceUrl?: string; observedAt?: string; notes?: string };
}

export interface RecordResult {
  externalId: string | null;
  outcome: IntakeOutcome | "ERROR";
  decisionId?: string | null; leadId?: string | null; contactId?: string | null;
  replayed?: boolean; reviewIds?: string[]; suppressed?: { phone: boolean; email: boolean };
  reasons?: string[]; errors?: string[]; retryable?: boolean;
  /** Dry run only: what intake would match. */
  matches?: { leadId: string | null; strength: string; reasons: string[]; customer: boolean }[];
}

export interface ImportResponse {
  apiVersion: string; batchId: string | null; dryRun: boolean; replayed: boolean;
  received: number; counts: Record<string, number>; results: RecordResult[];
}

export class ImportError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim().length > 0 && v.length <= max ? v.trim() : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Validates one record. Returns the record or a list of problems (never echoes values back). */
export function validateRecord(raw: unknown, i: number): { ok: true; rec: ImportRecord } | { ok: false; externalId: string | null; errors: string[] } {
  const errs: string[] = [];
  if (!isObj(raw)) return { ok: false, externalId: null, errors: [`records[${i}] must be an object`] };
  const externalId = typeof raw.externalId === "string" && /^[A-Za-z0-9._:\/-]{1,120}$/.test(raw.externalId) ? raw.externalId : null;
  if (!externalId) errs.push("externalId is required (1–120 characters: letters, digits, . _ : / -)");
  const b = raw.business;
  const name = isObj(b) ? str(b.name, 160) : undefined;
  if (!name) errs.push("business.name is required (1–160 characters)");
  let website: string | undefined;
  if (isObj(b) && b.website !== undefined) { website = str(b.website, 300); if (!website || !/^https?:\/\/[^\s]+$/.test(website)) errs.push("business.website must be an http(s) URL"); }
  let location: ImportRecord["business"]["location"];
  if (isObj(b) && b.location !== undefined) {
    if (!isObj(b.location)) errs.push("business.location must be an object");
    else location = { city: str(b.location.city, 80), region: str(b.location.region, 40), postalCode: str(b.location.postalCode, 12) };
  }
  const idList = (k: "phones" | "emails") => {
    const v = raw[k];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > 5) { errs.push(`${k} must be an array of at most 5 items`); return []; }
    return v.flatMap((x, j) => {
      if (!isObj(x) || !str(x.value, 120)) { errs.push(`${k}[${j}].value is required`); return []; }
      if (x.label !== undefined && !(LABELS as readonly unknown[]).includes(x.label)) errs.push(`${k}[${j}].label must be one of ${LABELS.join(", ")}`);
      if (x.verified !== undefined && typeof x.verified !== "boolean") errs.push(`${k}[${j}].verified must be a boolean`);
      return [{ value: String(x.value).trim(), label: x.label as (typeof LABELS)[number] | undefined, verified: x.verified === true }];
    });
  };
  const phones = idList("phones"), emails = idList("emails");
  if (!phones.length && !emails.length) errs.push("at least one phone or email is required");
  const verifiedFields = raw.verifiedFields === undefined ? [] : Array.isArray(raw.verifiedFields) && raw.verifiedFields.every((f) => (VERIFIABLE as readonly unknown[]).includes(f)) ? raw.verifiedFields as ImportRecord["verifiedFields"] : (errs.push(`verifiedFields may contain only ${VERIFIABLE.join(", ")}`), []);
  const confidence = raw.confidence === undefined ? undefined : typeof raw.confidence === "number" && raw.confidence >= 0 && raw.confidence <= 100 ? raw.confidence : (errs.push("confidence must be a number from 0 to 100"), undefined);
  const interest = raw.interest === undefined ? "other" : (INTERESTS as readonly unknown[]).includes(raw.interest) ? raw.interest as ImportRecord["interest"] : (errs.push(`interest must be one of ${INTERESTS.join(", ")}`), "other");
  let evidence: ImportRecord["evidence"];
  if (raw.evidence !== undefined) {
    if (!isObj(raw.evidence)) errs.push("evidence must be an object");
    else {
      const sourceUrl = raw.evidence.sourceUrl === undefined ? undefined : str(raw.evidence.sourceUrl, 500);
      if (raw.evidence.sourceUrl !== undefined && (!sourceUrl || !/^https?:\/\/[^\s]+$/.test(sourceUrl))) errs.push("evidence.sourceUrl must be an http(s) URL");
      const observedAt = raw.evidence.observedAt === undefined ? undefined : typeof raw.evidence.observedAt === "string" && !Number.isNaN(Date.parse(raw.evidence.observedAt)) ? raw.evidence.observedAt : (errs.push("evidence.observedAt must be an ISO-8601 date"), undefined);
      evidence = { sourceUrl, observedAt, notes: str(raw.evidence.notes, 500) };
    }
  }
  const contactName = isObj(raw.contact) ? str(raw.contact.name, 120) : undefined;
  if (errs.length) return { ok: false, externalId, errors: errs };
  return { ok: true, rec: { externalId: externalId!, business: { name: name!, website, location }, contact: contactName ? { name: contactName } : undefined, phones, emails, verifiedFields, confidence, interest, evidence } };
}

function toCandidate(r: ImportRecord): Candidate {
  return { contactName: r.contact?.name ?? null, businessName: r.business.name, website: r.business.website ?? null, location: r.business.location ?? null,
    phones: r.phones ?? [], emails: r.emails ?? [], verifiedFields: r.verifiedFields ?? [] };
}

/**
 * Processes one authenticated import request. `rawBody` is the exact signed body; `idempotencyKey` comes from the
 * Idempotency-Key header. Records are processed independently: one failure never rolls back the others.
 */
export async function runImport(db: Db, rawBody: string, p: { client: string; idempotencyKey: string; channel?: "research_agent" | "crm_api" }): Promise<ImportResponse> {
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(p.idempotencyKey)) throw new ImportError(400, "Idempotency-Key header is required (8–120 characters: letters, digits, . _ : -)");
  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { throw new ImportError(400, "Body must be JSON"); }
  if (!isObj(body)) throw new ImportError(400, "Body must be a JSON object");
  if (body.apiVersion !== IMPORT_API_VERSION) throw new ImportError(422, `apiVersion must be "${IMPORT_API_VERSION}"`);
  if (!Array.isArray(body.records) || body.records.length === 0) throw new ImportError(422, "records must be a non-empty array");
  if (body.records.length > MAX_RECORDS) throw new ImportError(413, `At most ${MAX_RECORDS} records per request`);
  const dryRun = body.dryRun === true;
  const channel = p.channel ?? "research_agent";
  const hash = await sha256Hex(rawBody);
  const at = nowIso();
  const results: RecordResult[] = [];

  let batchId: string | null = null, replayed = false;
  if (!dryRun) {
    const prev = await db.prepare(`SELECT id, request_hash FROM crm_import_batches WHERE idempotency_key = ?`).bind(p.idempotencyKey).first<{ id: string; request_hash: string }>();
    if (prev && prev.request_hash !== hash) throw new ImportError(409, "This Idempotency-Key was already used with a different request body.");
    if (prev) { batchId = prev.id; replayed = true; }
    else {
      batchId = newId("imp");
      const ins = await db.prepare(`INSERT INTO crm_import_batches (id, client, api_version, idempotency_key, request_hash, received, status, created_at) VALUES (?,?,?,?,?,?, 'processing', ?) ON CONFLICT(idempotency_key) DO NOTHING`)
        .bind(batchId, p.client, IMPORT_API_VERSION, p.idempotencyKey, hash, body.records.length, at).run();
      if (ins.meta.changes !== 1) {
        const again = await db.prepare(`SELECT id, request_hash FROM crm_import_batches WHERE idempotency_key = ?`).bind(p.idempotencyKey).first<{ id: string; request_hash: string }>();
        if (!again || again.request_hash !== hash) throw new ImportError(409, "This Idempotency-Key was already used with a different request body.");
        batchId = again.id; replayed = true;
      }
    }
  }

  const seen = new Set<string>();
  for (let i = 0; i < body.records.length; i++) {
    const v = validateRecord(body.records[i], i);
    if (!v.ok) { results.push({ externalId: v.externalId, outcome: "REJECTED_INVALID", errors: v.errors, retryable: false }); continue; }
    const rec = v.rec;
    if (seen.has(rec.externalId)) { results.push({ externalId: rec.externalId, outcome: "REJECTED_INVALID", errors: ["externalId appears more than once in this batch"], retryable: false }); continue; }
    seen.add(rec.externalId);
    try {
      if (dryRun) {
        const pv = await previewMatches(db, toCandidate(rec));
        results.push({ externalId: rec.externalId, outcome: pv.suppressed.phone || pv.suppressed.email ? "SUPPRESSED" : pv.matches.length ? "POSSIBLE_DUPLICATE_REVIEW" : "CREATED", suppressed: pv.suppressed,
          matches: pv.matches.map((m) => ({ leadId: m.leadId, strength: m.strength, reasons: m.reasons, customer: m.customer })), reasons: ["dry_run_prediction"] });
        continue;
      }
      const ev = rec.evidence;
      // Key = client + externalId + content: an identical resend replays; corrected data for the same business is a
      // new decision that matches the existing record (update / review), never a second lead.
      const contentKey = (await sha256Hex(JSON.stringify(rec))).slice(0, 16);
      const res = await intake(db, toCandidate(rec), {
        channel, idempotencyKey: `${channel}:${p.client}:${rec.externalId}:${contentKey}`, requestFingerprint: { interest: rec.interest, confidence: rec.confidence ?? null }, sourceRef: rec.externalId,
        confidence: rec.confidence, batchId,
        lead: { source: "manual", interest: rec.interest ?? "other",
          message: [`Prospect found by the ${p.client} research engine.`, ev?.sourceUrl ? `Source: ${ev.sourceUrl}` : null, ev?.observedAt ? `Observed: ${ev.observedAt}` : null, ev?.notes ? `Notes: ${ev.notes}` : null].filter(Boolean).join("\n"),
          activityBody: `Imported from ${p.client} (record ${rec.externalId}, batch ${batchId}). Public listing data: this is not consent to call or email.` },
      });
      results.push({ externalId: rec.externalId, outcome: res.outcome, decisionId: res.decisionId, leadId: res.leadId, contactId: res.contactId, replayed: res.replayed,
        reviewIds: res.reviewIds, suppressed: res.suppressed, reasons: res.reasons });
    } catch (e) {
      // Errors are reported without echoing record contents; the record can be retried with the same key.
      const conflict = e instanceof IntakeError && e.status === 409;
      results.push({ externalId: rec.externalId, outcome: "ERROR", errors: [conflict ? e.message : "Internal error while saving this record"], retryable: !(conflict && /already used/.test(e.message)) });
      if (!conflict) console.error(JSON.stringify({ level: "error", msg: "crm import record failed", batchId, externalId: rec.externalId, error: (e as Error).message.slice(0, 200) }));
    }
  }
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  if (batchId) {
    await db.prepare(`UPDATE crm_import_batches SET status = ?, counts_json = ?, completed_at = ? WHERE id = ?`).bind(counts.ERROR ? "partial" : "completed", JSON.stringify(counts), nowIso(), batchId).run();
  }
  return { apiVersion: IMPORT_API_VERSION, batchId, dryRun, replayed, received: body.records.length, counts, results };
}
