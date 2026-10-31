// Lead research — pure rules shared by the Cloudflare Worker (ingest, dashboard) and the Windows research worker
// (research-worker/). No I/O here. Every number the platform shows about a prospect is computed by these functions
// from evidence the worker recorded; the local model only drafts wording and never decides qualification.
//
// Vocabulary (kept separate on purpose, see docs/research/README.md):
//   evaluated  — a candidate business record the worker looked at (worker-reported count)
//   qualified  — a prospect whose evidence meets the qualification rule below (computed here)
//   callable   — a prospect the outbound eligibility gate releases for automated dialing (fail-closed; see gate below)

export const WEBSITE_CLASSES = [
  "VERIFIED_OFFICIAL_WEBSITE", "VERIFIED_WEBSITE_BROKEN", "VERIFIED_WEBSITE_ISSUES",
  "NO_OFFICIAL_WEBSITE_FOUND", "WEBSITE_UNVERIFIED", "BUSINESS_IDENTITY_UNCERTAIN",
] as const;
export type WebsiteClass = (typeof WEBSITE_CLASSES)[number];

export const WEBSITE_CLASS_LABELS: Record<WebsiteClass, string> = {
  VERIFIED_OFFICIAL_WEBSITE: "Official website verified, no material issues",
  VERIFIED_WEBSITE_BROKEN: "Official website verified, broken",
  VERIFIED_WEBSITE_ISSUES: "Official website verified, documented issues",
  NO_OFFICIAL_WEBSITE_FOUND: "No official website found after documented checks (not proof that none exists)",
  WEBSITE_UNVERIFIED: "Website not verified",
  BUSINESS_IDENTITY_UNCERTAIN: "Business identity uncertain",
};

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];
const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

export const SOURCE_IDS = ["overture", "foursquare_os", "osm_geofabrik", "common_crawl", "open_data"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export const PROSPECT_STATUSES = ["qualified", "not_qualified", "review", "promoted", "existing_crm", "suppressed", "dismissed"] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];

/** Crestmont package ids a prospect may be matched to (CRM `leads.interest` values). Prices are never stated here. */
export type PackageRecommendation = "starter" | "business" | "custom";

export interface Finding {
  code: string;            // machine code, e.g. "no_https", "http_5xx", "no_viewport_meta"
  title: string;           // factual statement of what was observed
  severity: Severity;
  confidence: number;      // 0..1
  url: string;             // the URL the test ran against
  method: string;          // how it was tested, e.g. "HTTP GET (no JS)", "Playwright 390x844 render", "Lighthouse 12 mobile"
  observedAt: string;      // ISO timestamp
  evidence: string;        // the observation itself (status code, header, element count…), ≤ 500 chars
  reproduction?: string;   // how a person can see it, ≤ 300 chars
}

export interface SourceRef { source: SourceId; sourceId: string; license: string; release?: string; retrievedAt: string }

export interface WebsiteCheck { stage: "A" | "B" | "C" | "D" | "E"; method: string; result: string; at: string }

export interface ProspectInput {
  businessKey: string;
  name: string;
  category?: string | null;
  address?: { line?: string | null; city?: string | null; state?: string | null; zip?: string | null };
  lat?: number | null;
  lon?: number | null;
  phones?: string[];
  emails?: string[];
  domains?: string[];
  sources: SourceRef[];
  website: { classification: WebsiteClass; url?: string | null; confidence: number; checkedAt: string; identitySignals?: string[]; checks?: WebsiteCheck[] };
  findings?: Finding[];
  identityConfidence: number;
  lastVerifiedAt: string;
  summary?: string | null;
  brief?: string | null;
  model?: string | null;
}

// ───────────── Normalization ─────────────

/** US/NANP numbers to E.164 (+1XXXXXXXXXX). Anything that cannot be trusted returns null (never guessed). */
export function phoneE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim().replace(/\s*(?:ext\.?|x|#)\s*\d{1,6}$/i, "");
  if (!/^[+0-9 ().\-/]{7,40}$/.test(s)) return null;
  const d = s.replace(/\D/g, "");
  let n: string | null = null;
  if (s.startsWith("+")) n = d.startsWith("1") && d.length === 11 ? d.slice(1) : null;
  else if (d.length === 10) n = d;
  else if (d.length === 11 && d.startsWith("1")) n = d.slice(1);
  // NANP: area code and exchange cannot start with 0 or 1; 555-01XX is fictional.
  if (!n || !/^[2-9]\d{2}[2-9]\d{6}$/.test(n) || /^\d{3}55501\d{2}$/.test(n)) return null;
  return `+1${n}`;
}

/** Same key as the CRM's contacts.phone_norm (10 digits, US country code dropped) for duplicate checks. */
export const crmPhoneNorm = (e164: string | null): string | null => (e164 && e164.startsWith("+1") ? e164.slice(2) : null);

export function normEmail(raw: string | null | undefined): string | null {
  const e = (raw ?? "").trim().toLowerCase().replace(/^mailto:/, "");
  return /^[^\s@<>"']{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}$/.test(e) ? e : null;
}

const FREE_MAIL = new Set(["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "me.com", "msn.com", "live.com", "comcast.net", "att.net", "sbcglobal.net", "verizon.net", "bellsouth.net", "ymail.com", "protonmail.com", "proton.me", "mail.com", "gmx.com", "charter.net", "cox.net", "earthlink.net"]);
export const isFreeMailDomain = (d: string) => FREE_MAIL.has(d.toLowerCase());

/** Hosts that are directories / social profiles, never a business's own official website. */
const NOT_OFFICIAL = /(^|\.)(facebook\.com|fb\.com|instagram\.com|twitter\.com|x\.com|linkedin\.com|yelp\.com|google\.com|goo\.gl|g\.page|business\.site|tripadvisor\.com|yellowpages\.com|bbb\.org|nextdoor\.com|foursquare\.com|mapquest\.com|tiktok\.com|youtube\.com|angi\.com|houzz\.com|thumbtack\.com|opentable\.com|doordash\.com|grubhub\.com|ubereats\.com|linktr\.ee|square\.site|wixsite\.com|godaddysites\.com)$/i;

/** Registrable-ish host for matching (lowercase, no scheme, no www., no port, no path). Null if not a public hostname. */
export function normDomain(raw: string | null | undefined): string | null {
  let s = (raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `http://${s}`;
  let host: string;
  try { host = new URL(s).hostname; } catch { return null; }
  host = host.replace(/^www\d?\./, "").replace(/\.$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || /^\d+(\.\d+){3}$/.test(host) || host.endsWith(".local") || host === "localhost") return null;
  return host;
}

/** A domain a business could own as its official site (not a social profile, directory, or site-builder subdomain). */
export const isCandidateOfficialDomain = (d: string | null) => !!d && !NOT_OFFICIAL.test(d);

const NAME_NOISE = /\b(llc|l\.l\.c|inc|incorporated|co|corp|corporation|company|ltd|pllc|pc|the|and|&)\b/g;
/** Business-name key for matching: lowercase, punctuation and legal suffixes removed, whitespace collapsed. */
export function normName(raw: string | null | undefined): string {
  return (raw ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/['’`]/g, "")
    .replace(/[^a-z0-9& ]+/g, " ").replace(NAME_NOISE, " ").replace(/\s+/g, " ").trim();
}

export function normState(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().toUpperCase();
  return US_STATE_TZ[s] !== undefined ? s : null;
}
export function normZip(raw: string | null | undefined): string | null {
  const m = /^(\d{5})(?:-?\d{4})?$/.exec((raw ?? "").trim());
  return m ? m[1] : null;
}

// ───────────── Time zone (for calling windows) ─────────────
// A state maps to one IANA zone only where the whole state observes it. States split across zones return null:
// the eligibility gate then treats the recipient's local time as unknown (fail-closed), never a guess.
export const US_STATE_TZ: Record<string, string | null> = {
  AL: "America/Chicago", AK: null, AZ: null, AR: "America/Chicago", CA: "America/Los_Angeles", CO: "America/Denver",
  CT: "America/New_York", DE: "America/New_York", DC: "America/New_York", FL: null, GA: "America/New_York", HI: "Pacific/Honolulu",
  ID: null, IL: "America/Chicago", IN: null, IA: "America/Chicago", KS: null, KY: null, LA: "America/Chicago", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: null, MN: "America/Chicago", MS: "America/Chicago", MO: "America/Chicago",
  MT: "America/Denver", NE: null, NV: null, NH: "America/New_York", NJ: "America/New_York", NM: "America/Denver", NY: "America/New_York",
  NC: "America/New_York", ND: null, OH: "America/New_York", OK: "America/Chicago", OR: null, PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", SD: null, TN: null, TX: null, UT: "America/Denver", VT: "America/New_York", VA: "America/New_York",
  WA: "America/Los_Angeles", WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver",
};
export const timeZoneForState = (state: string | null): string | null => (state ? US_STATE_TZ[state] ?? null : null);

// ───────────── Content hash (skip unchanged records) ─────────────
/** Stable JSON (sorted keys) so the same evidence always hashes the same. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

// ───────────── Validation of what the worker sends ─────────────

/** http(s) URL that the WHATWG parser accepts (a regex alone lets "http://%%%" through). */
const httpUrl = (x: unknown): string | null => {
  if (typeof x !== "string" || x.length > 500) return null;
  try { const u = new URL(x); return (u.protocol === "http:" || u.protocol === "https:") && u.hostname ? u.href : null; } catch { return null; }
};
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const clean = (s: unknown, max: number): string | null => {
  if (typeof s !== "string") return null;
  const t = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return t ? t.slice(0, max) : null;
};
const unit = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1 ? n : null);

export interface CleanProspect {
  businessKey: string; name: string; nameNorm: string; category: string | null;
  addressLine: string | null; city: string | null; state: string | null; zip: string | null; lat: number | null; lon: number | null;
  phones: string[]; emails: string[]; domains: string[]; sources: SourceRef[];
  website: ProspectInput["website"]; findings: Finding[]; identityConfidence: number; lastVerifiedAt: string;
  summary: string | null; brief: string | null; model: string | null;
}

/** Validates one prospect from the worker. Returns issues instead of throwing so a batch can reject single records. */
export function validateProspect(raw: unknown): { ok: true; value: CleanProspect } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, issues: ["record must be an object"] };
  const r = raw as Record<string, unknown>;
  const businessKey = typeof r.businessKey === "string" && /^[a-z_]{2,20}:[A-Za-z0-9._:\-]{1,120}$/.test(r.businessKey) ? r.businessKey : null;
  if (!businessKey) issues.push("businessKey must look like <source>:<id>");
  const name = clean(r.name, 200);
  if (!name || name.length < 2) issues.push("name is required");
  const addr = (r.address && typeof r.address === "object" ? r.address : {}) as Record<string, unknown>;
  const lat = typeof r.lat === "number" && r.lat >= -90 && r.lat <= 90 ? r.lat : null;
  const lon = typeof r.lon === "number" && r.lon >= -180 && r.lon <= 180 ? r.lon : null;
  const arr = (x: unknown, max: number) => (Array.isArray(x) ? x.slice(0, max) : []);
  const phones = [...new Set(arr(r.phones, 10).map((p) => phoneE164(typeof p === "string" ? p : null)).filter((p): p is string => !!p))];
  const emails = [...new Set(arr(r.emails, 10).map((e) => normEmail(typeof e === "string" ? e : null)).filter((e): e is string => !!e))];
  const domains = [...new Set(arr(r.domains, 10).map((d) => normDomain(typeof d === "string" ? d : null)).filter((d): d is string => !!d))];
  const sources: SourceRef[] = [];
  for (const s of arr(r.sources, 10)) {
    const o = (s ?? {}) as Record<string, unknown>;
    if (!(SOURCE_IDS as readonly string[]).includes(o.source as string)) { issues.push("sources[].source is not a known source"); continue; }
    const sourceId = clean(o.sourceId, 160), license = clean(o.license, 60), retrievedAt = typeof o.retrievedAt === "string" && ISO.test(o.retrievedAt) ? o.retrievedAt : null;
    if (!sourceId || !license || !retrievedAt) { issues.push("sources[] needs sourceId, license and retrievedAt"); continue; }
    sources.push({ source: o.source as SourceId, sourceId, license, release: clean(o.release, 40) ?? undefined, retrievedAt });
  }
  if (!sources.length) issues.push("at least one source with provenance is required");
  const w = (r.website && typeof r.website === "object" ? r.website : null) as Record<string, unknown> | null;
  const cls = w && (WEBSITE_CLASSES as readonly string[]).includes(w.classification as string) ? (w.classification as WebsiteClass) : null;
  if (!cls) issues.push("website.classification is not a known classification");
  const wConf = unit(w?.confidence);
  if (wConf === null) issues.push("website.confidence must be 0..1");
  const checkedAt = typeof w?.checkedAt === "string" && ISO.test(w.checkedAt) ? w.checkedAt : null;
  if (!checkedAt) issues.push("website.checkedAt must be an ISO timestamp");
  const wUrl = httpUrl(w?.url);
  if ((cls === "VERIFIED_OFFICIAL_WEBSITE" || cls === "VERIFIED_WEBSITE_BROKEN" || cls === "VERIFIED_WEBSITE_ISSUES") && !wUrl) issues.push("a verified website classification needs the verified url");
  if (cls === "NO_OFFICIAL_WEBSITE_FOUND" && !arr(w?.checks, 20).length) issues.push("NO_OFFICIAL_WEBSITE_FOUND needs the documented checks that were run");
  const checks: WebsiteCheck[] = arr(w?.checks, 20).flatMap((c) => {
    const o = (c ?? {}) as Record<string, unknown>;
    const stage = ["A", "B", "C", "D", "E"].includes(o.stage as string) ? (o.stage as WebsiteCheck["stage"]) : null;
    const method = clean(o.method, 120), result = clean(o.result, 300), at = typeof o.at === "string" && ISO.test(o.at) ? o.at : null;
    return stage && method && result && at ? [{ stage, method, result, at }] : [];
  });
  const findings: Finding[] = [];
  for (const f of arr(r.findings, 40)) {
    const o = (f ?? {}) as Record<string, unknown>;
    const code = typeof o.code === "string" && /^[a-z0-9_]{2,60}$/.test(o.code) ? o.code : null;
    const sev = (SEVERITIES as readonly string[]).includes(o.severity as string) ? (o.severity as Severity) : null;
    const conf = unit(o.confidence), title = clean(o.title, 200), url = httpUrl(o.url);
    const method = clean(o.method, 120), evidence = clean(o.evidence, 500), observedAt = typeof o.observedAt === "string" && ISO.test(o.observedAt) ? o.observedAt : null;
    // A finding without evidence, URL, method and timestamp is not a finding (no unsupported claims reach the CRM).
    if (!code || !sev || conf === null || !title || !url || !method || !evidence || !observedAt) { issues.push(`finding ${code ?? "?"} is missing evidence, url, method, timestamp, severity or confidence`); continue; }
    findings.push({ code, title, severity: sev, confidence: conf, url, method, evidence, observedAt, reproduction: clean(o.reproduction, 300) ?? undefined });
  }
  const idc = unit(r.identityConfidence);
  if (idc === null) issues.push("identityConfidence must be 0..1");
  const lastVerifiedAt = typeof r.lastVerifiedAt === "string" && ISO.test(r.lastVerifiedAt) ? r.lastVerifiedAt : null;
  if (!lastVerifiedAt) issues.push("lastVerifiedAt must be an ISO timestamp");
  if (issues.length) return { ok: false, issues };
  const signals = arr(w!.identitySignals, 20).map((s) => clean(s, 120)).filter((s): s is string => !!s);
  return { ok: true, value: {
    businessKey: businessKey!, name: name!, nameNorm: normName(name), category: clean(r.category, 120),
    addressLine: clean(addr.line, 200), city: clean(addr.city, 100), state: normState(addr.state as string), zip: normZip(addr.zip as string), lat, lon,
    phones, emails, domains, sources,
    website: { classification: cls!, url: wUrl, confidence: wConf!, checkedAt: checkedAt!, identitySignals: signals, checks },
    findings, identityConfidence: idc!, lastVerifiedAt: lastVerifiedAt!,
    summary: clean(r.summary, 1200), brief: clean(r.brief, 2000), model: clean(r.model, 100),
  } };
}

// ───────────── Qualification (deterministic) ─────────────

export interface Qualification { score: number; qualified: boolean; reasons: string[]; recommendedPackage: PackageRecommendation | null; maxSeverity: Severity | null }

export const DEFAULT_QUALIFY_THRESHOLD = 60;
/** Evidence older than this is stale: it lowers the score and blocks qualification until re-verified. */
export const STALE_AFTER_DAYS = 45;

/**
 * Score 0–100 from explicit evidence only. A finding counts only when its confidence is at least 0.6.
 * Qualification requires: a qualifying website class, identity confidence ≥ 0.7, a usable phone number,
 * fresh evidence, and score ≥ threshold. VERIFIED_OFFICIAL_WEBSITE, WEBSITE_UNVERIFIED and
 * BUSINESS_IDENTITY_UNCERTAIN never qualify: there is no evidenced opportunity, or the evidence is not about this business.
 */
export function qualify(p: Pick<CleanProspect, "website" | "findings" | "identityConfidence" | "phones" | "lastVerifiedAt">, opts: { threshold?: number; now?: Date } = {}): Qualification {
  const threshold = opts.threshold ?? DEFAULT_QUALIFY_THRESHOLD;
  const now = opts.now ?? new Date();
  const reasons: string[] = [];
  const counted = p.findings.filter((f) => f.confidence >= 0.6);
  const maxSeverity = counted.reduce<Severity | null>((m, f) => (!m || SEVERITY_RANK[f.severity] > SEVERITY_RANK[m] ? f.severity : m), null);
  const cls = p.website.classification;
  // Issues base 46 is derived from the qualification rule, not tuned to results: the weakest case the rule accepts
  // (one high-severity finding at confidence 0.6 = 7.2 points, identity 0.7 = -3, phone +10) must reach 60. The real-data
  // audit of 2026-10-30 found the old base (25) let no evidenced-problem site qualify while unverified "no website" did.
  let score = { VERIFIED_WEBSITE_BROKEN: 55, NO_OFFICIAL_WEBSITE_FOUND: 45, VERIFIED_WEBSITE_ISSUES: 46, VERIFIED_OFFICIAL_WEBSITE: 0, WEBSITE_UNVERIFIED: 0, BUSINESS_IDENTITY_UNCERTAIN: 0 }[cls];
  const sevPoints = counted.reduce((s, f) => s + { critical: 15, high: 12, medium: 6, low: 1 }[f.severity] * f.confidence, 0);
  if (cls === "VERIFIED_WEBSITE_BROKEN" || cls === "VERIFIED_WEBSITE_ISSUES") score += Math.min(35, sevPoints);
  if (cls === "NO_OFFICIAL_WEBSITE_FOUND") score += Math.round(Math.min(1, p.website.confidence) * 15);
  if (p.phones.length) score += 10; else reasons.push("no usable phone number");
  score += Math.round(p.identityConfidence * 10) - 10;
  const ageDays = (now.getTime() - Date.parse(p.lastVerifiedAt)) / 86400e3;
  const stale = ageDays > STALE_AFTER_DAYS;
  if (stale) { score -= 20; reasons.push(`evidence is ${Math.floor(ageDays)} days old`); }
  score = Math.max(0, Math.min(100, Math.round(score)));

  if (cls === "VERIFIED_OFFICIAL_WEBSITE") reasons.push("official website verified without material issues");
  if (cls === "WEBSITE_UNVERIFIED") reasons.push("website not verified");
  if (cls === "BUSINESS_IDENTITY_UNCERTAIN") reasons.push("business identity uncertain");
  if (cls === "VERIFIED_WEBSITE_ISSUES" && !counted.some((f) => SEVERITY_RANK[f.severity] >= 2)) reasons.push("no medium-or-higher issue with confidence ≥ 0.6");
  if (p.identityConfidence < 0.7) reasons.push("identity confidence below 0.7");
  if (score < threshold) reasons.push(`score ${score} below threshold ${threshold}`);
  const material = counted.filter((f) => SEVERITY_RANK[f.severity] >= 2);
  const evidencedIssues = material.some((f) => SEVERITY_RANK[f.severity] >= 3) || material.length >= 2;
  if (cls === "VERIFIED_WEBSITE_ISSUES" && !evidencedIssues) reasons.push("needs one high-severity or two medium problems with confidence ≥ 0.6");
  const classQualifies = cls === "VERIFIED_WEBSITE_BROKEN" || cls === "NO_OFFICIAL_WEBSITE_FOUND" || (cls === "VERIFIED_WEBSITE_ISSUES" && evidencedIssues);
  const qualified = classQualifies && p.identityConfidence >= 0.7 && p.phones.length > 0 && !stale && score >= threshold;
  return { score, qualified, reasons, recommendedPackage: qualified || classQualifies ? recommendPackage(cls, counted) : null, maxSeverity };
}

/**
 * Package matched to the evidenced need only. Premium is never recommended from automated evidence (its scope needs a
 * discovery conversation); "custom" is used when the evidence suggests functionality beyond a brochure site.
 */
export function recommendPackage(cls: WebsiteClass, findings: Finding[]): PackageRecommendation | null {
  if (cls === "NO_OFFICIAL_WEBSITE_FOUND") return "starter";
  if (cls === "VERIFIED_WEBSITE_BROKEN") return findings.some((f) => f.code === "ecommerce_checkout_error" || f.code === "booking_flow_error") ? "custom" : "business";
  if (cls === "VERIFIED_WEBSITE_ISSUES") return findings.filter((f) => SEVERITY_RANK[f.severity] >= 3).length >= 2 ? "business" : "starter";
  return null;
}

// ───────────── Model output guard ─────────────
/**
 * The local model's summary and sales brief are drafts. They are accepted only when they add no facts: no money
 * amounts, no percentages or guarantees, and no web address the evidence does not contain. Rejected text is dropped
 * (the dashboard then shows the deterministic evidence list only), never "fixed".
 */
export function modelTextProblems(text: string, allowedDomains: string[]): string[] {
  const problems: string[] = [];
  if (/[$€£]\s?\d|\d+\s?(dollars|usd)\b/i.test(text)) problems.push("mentions a money amount");
  if (/\d+(\.\d+)?\s?%/.test(text)) problems.push("states a percentage");
  if (/\b(guarantee[ds]?|double your|increase (your )?(sales|revenue|traffic) by|#1|number one on google|rank first)\b/i.test(text)) problems.push("makes a results claim");
  if (/\b(terrible|awful|garbage|horrible|embarrassing)\b/i.test(text)) problems.push("uses a subjective, unsupported judgement");
  const allowed = new Set(allowedDomains.map((d) => d.toLowerCase()));
  for (const m of text.matchAll(/\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+(?:com|net|org|biz|info|us|co|io|site|online|store|shop|xyz|app|dev))\b/gi)) {
    const host = normDomain(m[1]);
    if (host && !allowed.has(host)) problems.push(`mentions ${host}, which is not in the evidence`);
  }
  return problems;
}

// ───────────── Outbound eligibility gate (fail-closed) ─────────────

export interface EligibilityFacts {
  phoneE164: string | null;
  timeZone: string | null;
  onDnc: boolean;
  existingCrmRecord: boolean;
  sharedPhoneConflict: boolean;
  /** Founder + counsel approval of a cold-outreach consent design (none exists: D-14, MSA Sched. C.7). */
  complianceApproval: { approvedBy: string; approvedAt: string; reference: string } | null;
  /** Documented prior express (written) consent covering AI-voice marketing calls to this number. */
  marketingConsentEvidence: string | null;
  /** Mobile / landline classification; "unknown" when no reliable, permitted source exists. */
  lineType: "mobile" | "landline" | "voip" | "unknown";
}

export interface Eligibility { eligible: boolean; status: "eligible" | "blocked"; reasons: string[] }

/**
 * Decides whether a research prospect may be released to AUTOMATED (AI-voice) dialing. A number appearing in an open
 * dataset is not permission to call it, and B2B status is not a universal exemption. Every check must pass; any
 * unknown is a block. With today's data no prospect can pass: there is no compliance approval and no marketing
 * consent mechanism, so the gate reports the reasons and the count of callable leads stays 0.
 */
export function outboundEligibility(f: EligibilityFacts): Eligibility {
  const reasons: string[] = [];
  if (!f.complianceApproval) reasons.push("No legal/compliance approval for AI-voice outreach to research prospects (Founder decision D-14: inbound only)");
  if (!f.marketingConsentEvidence) reasons.push("No documented prior express consent for artificial/AI-voice calls to this number");
  if (!f.phoneE164) reasons.push("No valid US phone number");
  if (f.onDnc) reasons.push("Number is on the do-not-call list");
  if (f.existingCrmRecord) reasons.push("Existing CRM contact: outreach follows the CRM record and its history, not research");
  if (f.sharedPhoneConflict) reasons.push("Number is shared with another business record: needs a person to confirm who it reaches");
  if (!f.timeZone) reasons.push("Recipient time zone not established (state spans zones or is unknown)");
  if (f.lineType === "unknown") reasons.push("Line type (mobile/landline) not reliably known");
  return reasons.length ? { eligible: false, status: "blocked", reasons } : { eligible: true, status: "eligible", reasons: [] };
}
