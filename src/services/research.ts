// Lead research — persistence and CRM integration (proposed RESEARCH-001..006; see migrations/0051_lead_research.sql).
// The worker pushes evidence; this module validates it, recomputes qualification itself (the worker's opinion is not
// trusted), checks the CRM / do-not-call list / other prospects for duplicates, and keeps the fail-closed outbound
// eligibility result next to each prospect. Promotion to a CRM lead is a person's decision, audited.
import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import { HttpError } from "../app/http.ts";
import { can, type Actor } from "../domain/authz.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { audit } from "./security.ts";
import { intake, IntakeError, type IntakeOutcome } from "./contact-identity.ts";
import {
  validateProspect, qualify, modelTextProblems, outboundEligibility, crmPhoneNorm, timeZoneForState, stableJson,
  WEBSITE_CLASSES, WEBSITE_CLASS_LABELS, type CleanProspect, type ProspectStatus, type WebsiteClass, type SourceId,
} from "../domain/research.ts";

export const RUNNER_ID = /^[A-Za-z0-9._:-]{1,64}$/;
export const BATCH_ID = /^[A-Za-z0-9._:-]{8,80}$/;
/** A runner that has not checked in for this long is shown as offline. */
export const RUNNER_ONLINE_S = 180;
/** D1 allows at most 100 bound parameters per statement. */
const CHUNK = 90;

export interface ResearchSettings { paused: number; pause_reason: string | null; qualify_threshold: number; max_batch: number; updated_by: string | null; updated_at: string }
export interface SourceRow { source: SourceId; enabled: number; role: string; license: string; attribution: string; use_terms: string; disabled_reason: string | null; terms_url: string; verified_at: string }

export async function loadSettings(db: Db): Promise<ResearchSettings> {
  return (await db.prepare(`SELECT paused, pause_reason, qualify_threshold, max_batch, updated_by, updated_at FROM research_settings WHERE id = 1`).first<ResearchSettings>())!;
}
export async function listSources(db: Db): Promise<SourceRow[]> {
  return (await db.prepare(`SELECT * FROM research_sources ORDER BY enabled DESC, source`).all<SourceRow>()).results;
}

/** Owner-only: pause/resume and thresholds. Audited with the changed fields. */
export async function saveSettings(db: Db, actor: Actor, input: { paused: boolean; reason: string; threshold: number; maxBatch: number }): Promise<string[]> {
  const issues: string[] = [];
  if (!Number.isInteger(input.threshold) || input.threshold < 0 || input.threshold > 100) issues.push("Qualification threshold must be a whole number from 0 to 100");
  if (!Number.isInteger(input.maxBatch) || input.maxBatch < 1 || input.maxBatch > 500) issues.push("Batch size must be a whole number from 1 to 500");
  if (input.paused && input.reason.trim().length < 3) issues.push("Say why research is paused");
  if (input.reason.length > 300) issues.push("Reason is too long");
  if (issues.length) return issues;
  const before = await loadSettings(db);
  const reason = input.paused ? input.reason.trim() : null;
  await db.prepare(`UPDATE research_settings SET paused = ?, pause_reason = ?, qualify_threshold = ?, max_batch = ?, updated_by = ?, updated_at = ? WHERE id = 1`)
    .bind(input.paused ? 1 : 0, reason, input.threshold, input.maxBatch, actor.userId ?? null, nowIso()).run();
  const changed: Record<string, unknown> = {};
  if (before.paused !== (input.paused ? 1 : 0)) changed.paused = input.paused;
  if (before.qualify_threshold !== input.threshold) changed.qualify_threshold = input.threshold;
  if (before.max_batch !== input.maxBatch) changed.max_batch = input.maxBatch;
  await audit(db, { actorUserId: actor.userId, action: "research.settings_updated", subjectType: "research_settings", subjectId: "1", details: { ...changed, reason } });
  return [];
}

// ───────────── Runner channel ─────────────

const today = (d: Date) => d.toISOString().slice(0, 10);
const nonNegInt = (x: unknown) => (typeof x === "number" && Number.isInteger(x) && x >= 0 && x < 1e9 ? x : 0);

/** Worker check-in: records its status, returns the controls it must obey (pause, batch size, enabled sources). */
export async function heartbeat(db: Db, body: Record<string, unknown>, now: Date) {
  const runnerId = typeof body.runnerId === "string" && RUNNER_ID.test(body.runnerId) ? body.runnerId : null;
  if (!runnerId) throw new HttpError(422, "runnerId must be 1-64 characters of [A-Za-z0-9._:-]");
  const version = typeof body.version === "string" ? body.version.slice(0, 40) : null;
  const status = body.status && typeof body.status === "object" && !Array.isArray(body.status) ? body.status as Record<string, unknown> : {};
  let statusJson = JSON.stringify(status);
  if (statusJson.length > 20_000) statusJson = JSON.stringify({ truncated: true, evaluated: status.evaluated, websitesChecked: status.websitesChecked, failedJobs: status.failedJobs, queueDepth: status.queueDepth });
  const at = now.toISOString();
  const day = typeof status.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(status.day) ? status.day : today(now);
  // Counters are cumulative for the worker's day; MAX keeps a restarted worker (which resumes from its checkpoint) from lowering them.
  await db.batch([
    db.prepare(`INSERT INTO research_runners (runner_id, version, first_seen_at, last_seen_at, status_json) VALUES (?,?,?,?,?)
                ON CONFLICT(runner_id) DO UPDATE SET version = excluded.version, last_seen_at = excluded.last_seen_at, status_json = excluded.status_json`).bind(runnerId, version, at, at, statusJson),
    db.prepare(`INSERT INTO research_runner_days (day, runner_id, evaluated, websites_checked, failed_jobs, updated_at) VALUES (?,?,?,?,?,?)
                ON CONFLICT(day, runner_id) DO UPDATE SET evaluated = MAX(evaluated, excluded.evaluated), websites_checked = MAX(websites_checked, excluded.websites_checked),
                failed_jobs = MAX(failed_jobs, excluded.failed_jobs), updated_at = excluded.updated_at`)
      .bind(day, runnerId, nonNegInt(status.evaluated), nonNegInt(status.websitesChecked), nonNegInt(status.failedJobs), at),
  ]);
  const s = await loadSettings(db);
  const sources = (await listSources(db)).filter((x) => x.enabled).map((x) => x.source);
  return { paused: !!s.paused, pauseReason: s.pause_reason, qualifyThreshold: s.qualify_threshold, maxBatch: s.max_batch, enabledSources: sources, serverTime: at };
}

interface ExistingProspect { id: string; business_key: string; status: ProspectStatus; content_hash: string; crm_lead_id: string | null; first_seen_at: string }

async function selectIn<T>(db: Db, sql: (ph: string) => string, values: string[], extra: unknown[] = []): Promise<T[]> {
  const out: T[] = [];
  const uniq = [...new Set(values)];
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const chunk = uniq.slice(i, i + CHUNK);
    out.push(...(await db.prepare(sql(chunk.map(() => "?").join(","))).bind(...chunk, ...extra).all<T>()).results);
  }
  return out;
}

export interface BatchResult {
  batchId: string; accepted: number; created: number; updated: number; unchanged: number;
  rejected: { businessKey: string | null; issues: string[] }[]; crmMatches: number; duplicatesPrevented: number; replay?: true;
}

/**
 * Ingests one worker batch. Idempotent on batchId (a retried batch gets the stored result and writes nothing).
 * Duplicate protection, in order: same business_key → update in place; phone/email already on a CRM contact →
 * existing_crm (no second calling opportunity, linked to the CRM record); number on the do-not-call list →
 * suppressed; number shared with a different business → both kept, flagged for a person (never auto-merged).
 */
export async function ingestBatch(db: Db, body: Record<string, unknown>, now: Date): Promise<BatchResult> {
  const batchId = typeof body.batchId === "string" && BATCH_ID.test(body.batchId) ? body.batchId : null;
  const runnerId = typeof body.runnerId === "string" && RUNNER_ID.test(body.runnerId) ? body.runnerId : null;
  if (!batchId || !runnerId) throw new HttpError(422, "batchId (8-80 chars) and runnerId are required");
  const prior = await db.prepare(`SELECT result_json FROM research_batches WHERE batch_id = ?`).bind(batchId).first<{ result_json: string }>();
  if (prior) return { ...(JSON.parse(prior.result_json) as BatchResult), replay: true };
  const settings = await loadSettings(db);
  if (settings.paused) throw new HttpError(409, `Research is paused: ${settings.pause_reason ?? "by the Owner"}`);
  const records = Array.isArray(body.prospects) ? body.prospects : null;
  if (!records) throw new HttpError(422, "prospects must be an array");
  if (records.length > settings.max_batch) throw new HttpError(413, `At most ${settings.max_batch} prospects per batch`);
  const enabled = new Set((await listSources(db)).filter((s) => s.enabled).map((s) => s.source));
  const at = now.toISOString();

  const rejected: BatchResult["rejected"] = [];
  const valid: CleanProspect[] = [];
  const seenKeys = new Set<string>();
  for (const raw of records) {
    const r = validateProspect(raw);
    const key = typeof (raw as { businessKey?: unknown })?.businessKey === "string" ? String((raw as { businessKey: string }).businessKey).slice(0, 140) : null;
    if (!r.ok) { rejected.push({ businessKey: key, issues: r.issues }); continue; }
    const off = r.value.sources.filter((s) => !enabled.has(s.source)).map((s) => s.source);
    if (off.length) { rejected.push({ businessKey: key, issues: [`source disabled on the platform: ${[...new Set(off)].join(", ")}`] }); continue; }
    if (seenKeys.has(r.value.businessKey)) { rejected.push({ businessKey: key, issues: ["businessKey repeated within the batch"] }); continue; }
    seenKeys.add(r.value.businessKey);
    valid.push(r.value);
  }

  const keys = valid.map((p) => p.businessKey);
  const phones = valid.flatMap((p) => p.phones);
  const norms = phones.map((p) => crmPhoneNorm(p)).filter((x): x is string => !!x);
  const emails = valid.flatMap((p) => p.emails);
  const existing = new Map((await selectIn<ExistingProspect>(db, (ph) => `SELECT id, business_key, status, content_hash, crm_lead_id, first_seen_at FROM research_prospects WHERE business_key IN (${ph})`, keys)).map((e) => [e.business_key, e]));
  // CRM contacts by the same normalized keys the CRM's own duplicate detection uses (contacts.phone_norm / email_norm).
  const crmByPhone = new Map((await selectIn<{ phone_norm: string; id: string; lead_id: string | null }>(db, (ph) =>
    `SELECT c.phone_norm, c.id, (SELECT l.id FROM leads l WHERE l.contact_id = c.id AND l.merged_into_lead_id IS NULL ORDER BY l.created_at DESC LIMIT 1) AS lead_id FROM contacts c WHERE c.phone_norm IN (${ph})`, norms)).map((r) => [r.phone_norm, r]));
  const crmByEmail = new Map((await selectIn<{ email_norm: string; id: string; lead_id: string | null }>(db, (ph) =>
    `SELECT c.email_norm, c.id, (SELECT l.id FROM leads l WHERE l.contact_id = c.id AND l.merged_into_lead_id IS NULL ORDER BY l.created_at DESC LIMIT 1) AS lead_id FROM contacts c WHERE c.email_norm IN (${ph})`, emails)).map((r) => [r.email_norm, r]));
  const dnc = new Set((await selectIn<{ phone_e164: string }>(db, (ph) => `SELECT phone_e164 FROM voice_dnc WHERE phone_e164 IN (${ph})`, phones)).map((r) => r.phone_e164));
  const otherHolders = await selectIn<{ phone_e164: string; business_key: string }>(db, (ph) => `SELECT phone_e164, business_key FROM research_prospects WHERE phone_e164 IN (${ph})`, phones);
  // Phone → business keys already holding it (other prospects) plus those in this batch.
  const holders = new Map<string, Set<string>>();
  for (const h of otherHolders) (holders.get(h.phone_e164) ?? holders.set(h.phone_e164, new Set()).get(h.phone_e164)!).add(h.business_key);
  for (const p of valid) if (p.phones[0]) (holders.get(p.phones[0]) ?? holders.set(p.phones[0], new Set()).get(p.phones[0])!).add(p.businessKey);
  // The same business can appear as several dataset records with different numbers (or the same website for several
  // locations). A qualified record whose verified website, or whose name and street, already belongs to another record
  // goes to a person instead of becoming a second lead (found by the independent lead audit, 2026-10-30).
  const siteOf = (p: CleanProspect) => (p.website.url ? new URL(p.website.url).hostname.replace(/^www\d?\./, "") : null);
  const placeOf = (nameNorm: string | null, line: string | null) => (nameNorm && line ? `${nameNorm}|${line.toLowerCase().replace(/\s+/g, " ").trim()}` : null);
  const sites = [...new Set(valid.map(siteOf).filter((x): x is string => !!x))];
  const siteHolders = new Map<string, Set<string>>();
  for (const h of await selectIn<{ domain: string; business_key: string }>(db, (ph) => `SELECT domain, business_key FROM research_prospects WHERE website_url IS NOT NULL AND domain IN (${ph})`, sites))
    (siteHolders.get(h.domain) ?? siteHolders.set(h.domain, new Set()).get(h.domain)!).add(h.business_key);
  const placeHolders = new Map<string, Set<string>>();
  for (const h of await selectIn<{ name_norm: string; address_line: string | null; business_key: string }>(db, (ph) => `SELECT name_norm, address_line, business_key FROM research_prospects WHERE name_norm IN (${ph})`, [...new Set(valid.map((p) => p.nameNorm).filter(Boolean))])) {
    const k = placeOf(h.name_norm, h.address_line); if (k) (placeHolders.get(k) ?? placeHolders.set(k, new Set()).get(k)!).add(h.business_key);
  }
  const sameBusinessAs = (p: CleanProspect): string | null => {
    const site = siteOf(p), place = placeOf(p.nameNorm, p.addressLine);
    const other = (m: Map<string, Set<string>>, k: string | null) => (k ? [...(m.get(k) ?? [])].find((x) => x !== p.businessKey) ?? null : null);
    const hit = other(siteHolders, site) ? "website" : other(placeHolders, place) ? "name and street" : null;
    if (site) (siteHolders.get(site) ?? siteHolders.set(site, new Set()).get(site)!).add(p.businessKey);
    if (place) (placeHolders.get(place) ?? placeHolders.set(place, new Set()).get(place)!).add(p.businessKey);
    return hit;
  };

  let created = 0, updated = 0, unchanged = 0, crmMatches = 0, duplicatesPrevented = 0;
  const writes = [];
  const sharedPhones = new Set<string>();
  for (const p of valid) {
    const hash = await sha256Hex(stableJson(p));
    const prev = existing.get(p.businessKey);
    const phone = p.phones[0] ?? null;
    const shared = !!phone && (holders.get(phone)?.size ?? 0) > 1;
    if (shared) sharedPhones.add(phone!);
    const sameAs = sameBusinessAs(p);
    if (prev && prev.content_hash === hash && !shared) { unchanged++; continue; }
    const q = qualify(p, { threshold: settings.qualify_threshold, now });
    const crm = p.phones.map((x) => crmByPhone.get(crmPhoneNorm(x) ?? "")).find(Boolean) ?? p.emails.map((e) => crmByEmail.get(e)).find(Boolean) ?? null;
    const onDnc = p.phones.some((x) => dnc.has(x));
    const tz = timeZoneForState(p.state);
    const allowed = [...p.domains, ...(p.website.url ? [p.website.url] : [])];
    const summary = p.summary && !modelTextProblems(p.summary, allowed).length ? p.summary : null;
    const brief = p.brief && !modelTextProblems(p.brief, allowed).length ? p.brief : null;
    let status: ProspectStatus, detail: string | null = null;
    if (prev && (prev.status === "promoted" || prev.status === "dismissed")) { status = prev.status; detail = "Evidence refreshed; decision kept"; }
    else if (crm) { status = "existing_crm"; detail = "Phone or email already belongs to a CRM contact"; }
    else if (onDnc) { status = "suppressed"; detail = "Number is on the do-not-call list"; }
    else if (shared && q.qualified) { status = "review"; detail = "Phone number shared with another business record"; }
    else if (sameAs && q.qualified) { status = "review"; detail = `Same ${sameAs} as another business record (same business or another location)`; }
    else status = q.qualified ? "qualified" : "not_qualified";
    if (crm && !prev) crmMatches++;
    if ((crm || (shared && q.qualified) || (sameAs && status === "review")) && !prev) duplicatesPrevented++;
    const elig = outboundEligibility({ phoneE164: phone, timeZone: tz, onDnc, existingCrmRecord: !!crm, sharedPhoneConflict: shared, complianceApproval: null, marketingConsentEvidence: null, lineType: "unknown" });
    const domain = p.website.url ? new URL(p.website.url).hostname.replace(/^www\d?\./, "") : p.domains[0] ?? null;
    const vals = [p.name, p.nameNorm, p.category, p.addressLine, p.city, p.state, p.zip, p.lat, p.lon, phone, crmPhoneNorm(phone), JSON.stringify(p.phones), p.emails[0] ?? null, JSON.stringify(p.emails), domain, JSON.stringify(p.domains), tz,
      JSON.stringify(p.sources), p.website.classification, p.website.url ?? null, JSON.stringify({ confidence: p.website.confidence, checkedAt: p.website.checkedAt, identitySignals: p.website.identitySignals ?? [], checks: p.website.checks ?? [] }),
      JSON.stringify(p.findings), p.findings.length, q.maxSeverity, p.identityConfidence, q.score, q.qualified ? 1 : 0, JSON.stringify(q.reasons), q.recommendedPackage, summary, brief, summary || brief ? p.model : null,
      status, detail, crm?.lead_id ?? prev?.crm_lead_id ?? null, crm?.id ?? null, shared ? 1 : 0, elig.status, JSON.stringify(elig.reasons), hash, p.lastVerifiedAt, at];
    if (prev) {
      updated++;
      writes.push(db.prepare(`UPDATE research_prospects SET name=?, name_norm=?, category=?, address_line=?, city=?, state=?, zip=?, lat=?, lon=?, phone_e164=?, phone_norm=?, phones_json=?, email=?, emails_json=?, domain=?, domains_json=?, time_zone=?,
          sources_json=?, website_class=?, website_url=?, website_json=?, findings_json=?, findings_count=?, max_severity=?, identity_confidence=?, score=?, qualified=?, qualification_json=?, recommended_package=?, summary=?, brief=?, model=?,
          status = CASE WHEN status IN ('promoted','dismissed') THEN status ELSE ? END, status_detail = CASE WHEN status IN ('promoted','dismissed') THEN status_detail ELSE ? END,
          crm_lead_id = CASE WHEN status = 'promoted' THEN crm_lead_id ELSE ? END, crm_contact_id = CASE WHEN status = 'promoted' THEN crm_contact_id ELSE ? END,
          shared_phone=?, eligibility=?, eligibility_json=?, content_hash=?, last_verified_at=?, updated_at=? WHERE id = ?`).bind(...vals, prev.id));
    } else {
      created++;
      writes.push(db.prepare(`INSERT INTO research_prospects (name, name_norm, category, address_line, city, state, zip, lat, lon, phone_e164, phone_norm, phones_json, email, emails_json, domain, domains_json, time_zone,
          sources_json, website_class, website_url, website_json, findings_json, findings_count, max_severity, identity_confidence, score, qualified, qualification_json, recommended_package, summary, brief, model,
          status, status_detail, crm_lead_id, crm_contact_id, shared_phone, eligibility, eligibility_json, content_hash, last_verified_at, updated_at, id, business_key, first_seen_at)
          VALUES (${Array(45).fill("?").join(",")})`).bind(...vals, newId("rp"), p.businessKey, at));
    }
  }
  // (A person's decision made while this batch was in flight is re-read at write time above and never overwritten.)
  // Earlier holders of a now-shared number are flagged too; a qualified one goes to review so only a person can pick who is called.
  for (const ph of sharedPhones) {
    writes.push(db.prepare(`UPDATE research_prospects SET shared_phone = 1, status = CASE WHEN status = 'qualified' THEN 'review' ELSE status END,
        status_detail = CASE WHEN status = 'qualified' THEN 'Phone number shared with another business record' ELSE status_detail END, updated_at = ? WHERE phone_e164 = ? AND shared_phone = 0`).bind(at, ph));
  }
  const result: BatchResult = { batchId, accepted: valid.length, created, updated, unchanged, rejected, crmMatches, duplicatesPrevented };
  writes.push(db.prepare(`INSERT INTO research_batches (batch_id, runner_id, received_at, record_count, created, updated, unchanged, rejected, crm_matches, duplicates_prevented, result_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(batchId, runnerId, at, records.length, created, updated, unchanged, rejected.length, crmMatches, duplicatesPrevented, JSON.stringify(result)));
  try {
    await db.batch(writes);
  } catch (e) {
    // The same batch arriving twice at once (a worker retry racing its first attempt): the batch is atomic, so the
    // loser wrote nothing. Answer with the winner's stored result instead of an error.
    const won = await db.prepare(`SELECT result_json FROM research_batches WHERE batch_id = ?`).bind(batchId).first<{ result_json: string }>();
    if (won) return { ...(JSON.parse(won.result_json) as BatchResult), replay: true };
    throw e;
  }
  await applySuppressions(db);
  return result;
}

/** Opt-outs recorded after ingest (voice_dnc) take effect on prospects immediately, before anyone can promote them. */
export async function applySuppressions(db: Db): Promise<number> {
  const r = await db.prepare(`UPDATE research_prospects SET status = 'suppressed', status_detail = 'Number is on the do-not-call list', updated_at = ?
      WHERE status IN ('qualified','not_qualified','review') AND EXISTS (SELECT 1 FROM json_each(research_prospects.phones_json) j JOIN voice_dnc d ON d.phone_e164 = j.value)`).bind(nowIso()).run();
  return r.meta?.changes ?? 0;
}

// ───────────── Decisions (people) ─────────────

export interface ProspectRow {
  id: string; business_key: string; name: string; category: string | null; address_line: string | null; city: string | null; state: string | null; zip: string | null;
  phone_e164: string | null; email: string | null; domain: string | null; time_zone: string | null; sources_json: string; website_class: WebsiteClass; website_url: string | null;
  website_json: string; findings_json: string; findings_count: number; max_severity: string | null; identity_confidence: number; score: number; qualified: number; qualification_json: string;
  recommended_package: string | null; summary: string | null; brief: string | null; model: string | null; status: ProspectStatus; status_detail: string | null; crm_lead_id: string | null;
  shared_phone: number; eligibility: string; eligibility_json: string; last_verified_at: string; first_seen_at: string; updated_at: string;
}

export async function getProspect(db: Db, id: string): Promise<ProspectRow> {
  const p = await db.prepare(`SELECT * FROM research_prospects WHERE id = ?`).bind(id).first<ProspectRow>();
  if (!p) throw new HttpError(404, "Prospect not found");
  return p;
}

/** Lead text for the CRM: the deterministic evidence only (the model draft stays on the research record). */
export function evidenceText(p: ProspectRow): string {
  const findings = JSON.parse(p.findings_json) as { title: string; severity: string; url: string; method: string; observedAt: string; evidence: string }[];
  const sources = (JSON.parse(p.sources_json) as { source: string; sourceId: string; license: string }[]).map((s) => `${s.source} ${s.sourceId} (${s.license})`).join("; ");
  const lines = [
    `Lead research prospect ${p.id}. Website: ${WEBSITE_CLASS_LABELS[p.website_class]}${p.website_url ? ` — ${p.website_url}` : ""}.`,
    `Evidence last verified ${p.last_verified_at}. Score ${p.score}/100 (computed from the findings below).`,
    ...findings.slice(0, 12).map((f) => `• [${f.severity}] ${f.title} — ${f.evidence} (${f.method}, ${f.url}, ${f.observedAt})`),
    `Sources: ${sources}.`,
    `Outbound: not released for automated calling (${(JSON.parse(p.eligibility_json) as string[])[0] ?? "blocked"}).`,
  ];
  return lines.join("\n").slice(0, 5000);
}

/**
 * Hands a prospect to the CRM's authoritative intake engine (src/services/contact-identity.ts, channel
 * "research_agent"): it alone decides whether this is a new contact, an existing one, a shared identifier that needs a
 * person, a customer, or a suppressed number, and it records that decision with its evidence. The idempotency key is
 * fixed per prospect, so two people promoting at once (or a retry) get the same decision and at most one lead.
 * Research only reflects the outcome on its own record; automated calling stays off whatever the outcome.
 */
export async function promote(db: Db, actor: Actor, id: string): Promise<{ leadId: string; outcome: IntakeOutcome }> {
  if (!can(actor, "lead.write_all")) throw new HttpError(403, "You do not have permission to do that.");
  await applySuppressions(db);
  const p = await getProspect(db, id);
  const block = async (why: string, status?: ProspectStatus, extra: Record<string, unknown> = {}) => {
    if (status) await db.prepare(`UPDATE research_prospects SET status = ?, status_detail = ?, updated_at = ? WHERE id = ? AND status IN ('qualified','review')`).bind(status, why.slice(0, 300), nowIso(), id).run();
    await audit(db, { actorUserId: actor.userId, action: "research.promotion_blocked", subjectType: "research_prospect", subjectId: id, details: { reason: why, ...extra } });
    return new HttpError(409, why);
  };
  if (!["qualified", "review"].includes(p.status)) throw await block(`This prospect cannot be promoted (status: ${p.status.replace("_", " ")})`);
  const lists = (await db.prepare(`SELECT phones_json, emails_json FROM research_prospects WHERE id = ?`).bind(id).first<{ phones_json: string; emails_json: string }>())!;
  const phones = (JSON.parse(lists.phones_json) as string[]).slice(0, 10);
  const emails = (JSON.parse(lists.emails_json) as string[]).slice(0, 10);
  const verifiedSite = p.website_class === "VERIFIED_WEBSITE_ISSUES" || p.website_class === "VERIFIED_WEBSITE_BROKEN" || p.website_class === "VERIFIED_OFFICIAL_WEBSITE";
  const res = await intake(db, {
    businessName: p.name, contactName: null, website: verifiedSite ? p.website_url : null,
    location: { city: p.city, region: p.state, postalCode: p.zip },
    phones: phones.map((value, i) => ({ value, label: i === 0 ? "main" as const : "other" as const })), emails: emails.map((value) => ({ value })),
    verifiedFields: verifiedSite ? ["website"] : [],
  }, {
    channel: "research_agent", actor, idempotencyKey: `research_agent:promote:${p.id}`, sourceRef: p.business_key,
    confidence: Math.round(p.identity_confidence * 100), requestFingerprint: { prospect: p.id },
    lead: { source: "manual", interest: p.recommended_package ?? "other", message: evidenceText(p),
      utm: { utm_source: "crestmont-research", utm_medium: "research-agent", utm_campaign: p.website_class.toLowerCase() },
      activityBody: `Promoted from lead research (${p.id}); research evidence last verified ${p.last_verified_at}. Public listing data: not consent to call or email. Not released for automated calling.` },
  }).catch(async (e) => { throw e instanceof IntakeError && e.status === 409 ? await block(e.message) : e; });
  if (res.outcome === "SUPPRESSED") throw await block("The CRM has this number or email suppressed (do-not-call, email suppression or erasure)", "suppressed", { decision: res.decisionId });
  if (res.outcome === "REJECTED_INVALID") throw await block(`The CRM rejected the record: ${res.reasons.join("; ").slice(0, 200)}`, undefined, { decision: res.decisionId });
  if (res.outcome === "POSSIBLE_DUPLICATE_REVIEW") throw await block("Possible duplicate: the CRM put this record in its duplicate review queue for a person to decide", "review", { decision: res.decisionId, reviews: res.reviewIds });
  if (!res.leadCreated && res.contactId) {
    await db.prepare(`UPDATE research_prospects SET status = 'existing_crm', status_detail = ?, crm_lead_id = COALESCE(?, crm_lead_id), crm_contact_id = ?, updated_at = ? WHERE id = ? AND status IN ('qualified','review')`)
      .bind(`Matched an existing CRM record (${res.outcome.toLowerCase().replace(/_/g, " ")})`, res.leadId, res.contactId, nowIso(), id).run();
    throw await block("The phone number, email or business already belongs to a CRM contact; no second lead was created", undefined, { decision: res.decisionId, outcome: res.outcome });
  }
  if (!res.leadId) throw await block("The CRM did not create a lead");
  const at = nowIso();
  await db.prepare(`UPDATE research_prospects SET status = 'promoted', status_detail = NULL, crm_lead_id = ?, crm_contact_id = ?, decided_by = COALESCE(decided_by, ?), decided_at = COALESCE(decided_at, ?), updated_at = ? WHERE id = ?`)
    .bind(res.leadId, res.contactId, actor.userId ?? null, at, at, id).run();
  if (!res.replayed) {
    await audit(db, { actorUserId: actor.userId, action: "lead.created", subjectType: "lead", subjectId: res.leadId, details: { source: "manual", origin: "research_agent", prospect: id, decision: res.decisionId } });
    await audit(db, { actorUserId: actor.userId, action: "research.prospect_promoted", subjectType: "research_prospect", subjectId: id, details: { leadId: res.leadId, decision: res.decisionId, websiteClass: p.website_class, score: p.score } });
  }
  return { leadId: res.leadId, outcome: res.outcome };
}

export async function dismiss(db: Db, actor: Actor, id: string, reason: string): Promise<void> {
  if (!can(actor, "lead.write_all")) throw new HttpError(403, "You do not have permission to do that.");
  const r = reason.trim();
  if (r.length < 3 || r.length > 300) throw new HttpError(422, "Give a short reason (3-300 characters)");
  const p = await getProspect(db, id);
  if (p.status === "promoted") throw new HttpError(409, "Already a CRM lead; manage it in the CRM");
  const res = await db.prepare(`UPDATE research_prospects SET status = 'dismissed', status_detail = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status <> 'promoted'`).bind(r, actor.userId ?? null, nowIso(), nowIso(), id).run();
  if (!res.meta?.changes) throw new HttpError(409, "Already a CRM lead; manage it in the CRM");
  await audit(db, { actorUserId: actor.userId, action: "research.prospect_dismissed", subjectType: "research_prospect", subjectId: id, details: { reason: r } });
}

// ───────────── Dashboard ─────────────

export interface RunnerRow { runner_id: string; version: string | null; first_seen_at: string; last_seen_at: string; status_json: string }

export async function dashboard(db: Db, now: Date) {
  const day = today(now);
  const dayStart = `${day}T00:00:00.000Z`;
  const since24h = new Date(now.getTime() - 86400e3).toISOString();
  const n = async (sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<{ n: number | null }>())?.n ?? 0;
  const [total, qualifiedToday, qualifiedAll, callable, evaluatedToday, websitesToday, failedToday, dupToday, dupAll, receivedToday, awaiting, rejectedToday] = await Promise.all([
    n(`SELECT COUNT(*) AS n FROM research_prospects`),
    n(`SELECT COUNT(*) AS n FROM research_prospects WHERE qualified = 1 AND first_seen_at >= ?`, dayStart),
    n(`SELECT COUNT(*) AS n FROM research_prospects WHERE status IN ('qualified','review')`),
    n(`SELECT COUNT(*) AS n FROM research_prospects WHERE eligibility = 'eligible' AND updated_at >= ?`, dayStart),
    n(`SELECT SUM(evaluated) AS n FROM research_runner_days WHERE day = ?`, day),
    n(`SELECT SUM(websites_checked) AS n FROM research_runner_days WHERE day = ?`, day),
    n(`SELECT SUM(failed_jobs) AS n FROM research_runner_days WHERE day = ?`, day),
    n(`SELECT SUM(duplicates_prevented) AS n FROM research_batches WHERE received_at >= ?`, dayStart),
    n(`SELECT SUM(duplicates_prevented) AS n FROM research_batches`),
    n(`SELECT SUM(record_count) AS n FROM research_batches WHERE received_at >= ?`, dayStart),
    n(`SELECT COUNT(*) AS n FROM research_prospects WHERE website_class IN ('WEBSITE_UNVERIFIED','BUSINESS_IDENTITY_UNCERTAIN') OR status = 'review'`),
    n(`SELECT SUM(rejected) AS n FROM research_batches WHERE received_at >= ?`, dayStart),
  ]);
  const classes = new Map((await db.prepare(`SELECT website_class AS k, COUNT(*) AS n FROM research_prospects GROUP BY website_class`).all<{ k: string; n: number }>()).results.map((r) => [r.k, r.n]));
  const byClass = WEBSITE_CLASSES.map((k) => ({ key: k, label: WEBSITE_CLASS_LABELS[k], n: classes.get(k) ?? 0 }));
  const byStatus = (await db.prepare(`SELECT status AS k, COUNT(*) AS n FROM research_prospects GROUP BY status ORDER BY n DESC`).all<{ k: string; n: number }>()).results;
  const coverage = (await db.prepare(`SELECT json_extract(j.value, '$.source') AS source, COUNT(DISTINCT p.id) AS n FROM research_prospects p, json_each(p.sources_json) j GROUP BY source ORDER BY n DESC`).all<{ source: string; n: number }>()).results;
  const hourly = (await db.prepare(`SELECT substr(received_at, 1, 13) AS hour, SUM(record_count) AS n FROM research_batches WHERE received_at >= ? GROUP BY hour ORDER BY hour`).bind(since24h).all<{ hour: string; n: number }>()).results;
  const runners = (await db.prepare(`SELECT * FROM research_runners ORDER BY last_seen_at DESC LIMIT 10`).all<RunnerRow>()).results;
  // CRM import success rate over 30 days: successful promotions / (successful + blocked attempts), from the audit log.
  const since30 = new Date(now.getTime() - 30 * 86400e3).toISOString();
  const promoted30 = await n(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'research.prospect_promoted' AND created_at >= ?`, since30);
  const blocked30 = await n(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'research.promotion_blocked' AND created_at >= ?`, since30);
  return {
    total, qualifiedToday, qualifiedAll, callable, evaluatedToday, websitesToday, failedToday, rejectedToday, dupToday, dupAll, receivedToday, awaiting,
    byClass, byStatus, coverage, hourly, runners, promoted30, blocked30,
    importRate: promoted30 + blocked30 ? promoted30 / (promoted30 + blocked30) : null,
  };
}

export async function listProspects(db: Db, f: { status?: string; cls?: string; state?: string }, page: { limit: number; offset: number }): Promise<ProspectRow[]> {
  const where: string[] = [], binds: unknown[] = [];
  if (f.status) { where.push(`status = ?`); binds.push(f.status); }
  if (f.cls) { where.push(`website_class = ?`); binds.push(f.cls); }
  if (f.state) { where.push(`state = ?`); binds.push(f.state); }
  return (await db.prepare(`SELECT * FROM research_prospects ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY CASE status WHEN 'review' THEN 0 WHEN 'qualified' THEN 1 ELSE 2 END, score DESC, updated_at DESC LIMIT ? OFFSET ?`)
    .bind(...binds, page.limit + 1, page.offset).all<ProspectRow>()).results;
}
