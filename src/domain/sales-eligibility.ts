// Outbound AI sales representative — pure rules (no I/O). The compliance gate lives here, separate from the sales
// conversation (src/services/sales-functions.ts) and from orchestration (src/services/sales-outbound.ts), so it can be
// reviewed by counsel on its own and tested exhaustively.
//
// Background (docs/voice/OUTBOUND-SALES.md §4, docs/legal/RESEARCH-NOTES-2026-10.md rows 4–10):
//  - FCC 24-17 (Feb 2024): AI-generated voices are "artificial or prerecorded voice" under the TCPA. Telemarketing calls
//    using them need prior express WRITTEN consent (47 CFR 64.1200(a)(2)/(a)(3), definition at (f)(9)).
//  - A number in an open dataset, or B2B status, is not consent. Founder decision D-14 keeps AI outbound sales closed
//    until a counsel-approved consent design exists; the gate encodes that as `complianceApproval`.
//  - Calling hours: federal 8 a.m.–9 p.m. recipient-local; several states are stricter (e.g. 8 p.m. end in FL/OK/MD/WA,
//    no Sunday/holiday sales calls in AL/LA/MS/UT, Texas Sunday noon). The window below is deliberately narrower than all
//    of them (weekdays only, 10:00–19:00 local, no US federal holidays, Maine 10:00–17:00) and is a planning default
//    that counsel must confirm, not legal advice.
import { outboundEligibility } from "./research.ts";

export const SALES_OUTCOMES = ["no_answer", "voicemail", "wrong_number", "not_interested", "interested", "follow_up_requested",
  "consultation_booked", "checkout_sent", "payment_confirmed", "do_not_call", "technical_failure", "unclassified"] as const;
export type SalesOutcome = (typeof SALES_OUTCOMES)[number];

/** Outcomes the agent itself may report through update_outbound_lead.sales_outcome (the rest come from system facts). */
export const AGENT_DISPOSITIONS = ["wrong_number", "not_interested", "interested", "follow_up_requested"] as const;
export type AgentDisposition = (typeof AGENT_DISPOSITIONS)[number];

export const WEBSITE_STATUSES = ["no_website", "poor_quality_website", "broken_website", "outdated_website", "unknown"] as const;
export type WebsiteStatus = (typeof WEBSITE_STATUSES)[number];

// ───────────── Research → spoken context ─────────────

export interface ResearchFinding { code: string; title: string; severity: "low" | "medium" | "high" | "critical"; confidence: number; observedAt?: string }

/** Finding codes from research-worker/src/audit.ts that indicate an outdated (rather than merely poor) site. */
const OUTDATED_CODES = new Set(["stale_copyright", "obsolete_markup", "frameset", "marquee", "no_viewport_meta"]);
const SEV_RANK = { low: 1, medium: 2, high: 3, critical: 4 } as const;
/** Findings below this confidence are never used to personalise a call. */
export const MIN_SPOKEN_CONFIDENCE = 0.7;
/** Evidence older than this is treated as unverified (matches research STALE_AFTER_DAYS). */
export const RESEARCH_FRESH_DAYS = 45;

/** Plain-language, speakable descriptions of verified findings. Codes not listed are not spoken (title stays internal). */
const SPOKEN: Record<string, string> = {
  http_5xx: "the website was returning a server error when we checked",
  http_404: "the website's main page could not be found when we checked",
  render_blank: "the website loaded as a blank page when we checked",
  empty_page: "the website's main page had no visible content when we checked",
  no_https: "the website does not use a secure (https) connection",
  mixed_content: "parts of the website load over an insecure connection",
  insecure_form: "a form on the website sends information over an insecure connection",
  no_viewport_meta: "the website is not set up for phones",
  mobile_horizontal_scroll: "the website does not fit on a phone screen",
  small_tap_targets: "buttons and links on the website are hard to tap on a phone",
  stale_copyright: "the website's copyright date looks several years out of date",
  obsolete_markup: "the website uses outdated web technology",
  frameset: "the website uses outdated web technology",
  marquee: "the website uses outdated web technology",
  slow_response: "the website was slow to respond when we checked",
  broken_internal_links: "some links on the website are broken",
  no_contact_method: "we could not find a contact form or contact details on the website",
  missing_title: "the website's pages are missing titles search engines use",
  missing_meta_description: "the website is missing descriptions search engines show",
  lighthouse_performance: "the website scored poorly on a standard speed test",
  lighthouse_accessibility: "the website scored poorly on a standard accessibility check",
  lighthouse_seo: "the website scored poorly on a standard search-engine check",
  script_errors: "the website shows script errors when it loads",
  redirect_chain: "the website goes through several redirects before it loads",
};

export interface ResearchFacts {
  websiteClass: string | null;         // research_prospects.website_class (null = no research record)
  websiteUrl: string | null;
  findings: ResearchFinding[];
  identityConfidence: number | null;
  lastVerifiedAt: string | null;
  recommendedPackage: string | null;
}

export interface SpokenContext {
  website_status: WebsiteStatus;
  research_verified: boolean;
  /** Up to three speakable issue sentences, highest severity first. Empty when unverified. */
  verified_issues: string[];
  /** One issue for the opening line, or "" (neutral introduction). */
  primary_issue: string;
  research_confidence: "high" | "medium" | "low" | "none";
  recommended_service: string;
}

const PACKAGE_LABEL: Record<string, string> = { starter: "Starter website package", business: "Business website package", premium: "Premium website package", custom: "Custom website development" };

/**
 * Maps research evidence to what the agent may use to personalise the call. Fail-closed: no research, stale evidence,
 * low identity confidence or an unrecognised class all produce `unknown` with no issues, so the agent must use the
 * neutral introduction. Nothing here is invented; every sentence maps 1:1 to a recorded, evidenced finding code.
 */
export function spokenContext(r: ResearchFacts, now: Date = new Date()): SpokenContext {
  const neutral: SpokenContext = { website_status: "unknown", research_verified: false, verified_issues: [], primary_issue: "", research_confidence: "none", recommended_service: "" };
  if (!r.websiteClass || !r.lastVerifiedAt) return neutral;
  const age = now.getTime() - Date.parse(r.lastVerifiedAt);
  if (!Number.isFinite(age) || age < 0 || age > RESEARCH_FRESH_DAYS * 86_400_000) return neutral;
  if ((r.identityConfidence ?? 0) < 0.6) return neutral;
  const usable = r.findings.filter((f) => f.confidence >= MIN_SPOKEN_CONFIDENCE && SPOKEN[f.code])
    .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.confidence - a.confidence);
  const sentences = [...new Set(usable.map((f) => SPOKEN[f.code]))].slice(0, 3);
  let status: WebsiteStatus;
  switch (r.websiteClass) {
    case "NO_OFFICIAL_WEBSITE_FOUND": status = "no_website"; break;
    case "VERIFIED_WEBSITE_BROKEN": status = "broken_website"; break;
    case "VERIFIED_WEBSITE_ISSUES": {
      const material = usable.filter((f) => SEV_RANK[f.severity] >= 2);
      if (!material.length) return neutral;   // nothing verified enough to say
      status = material.some((f) => OUTDATED_CODES.has(f.code)) && material.filter((f) => OUTDATED_CODES.has(f.code)).length >= material.length / 2 ? "outdated_website" : "poor_quality_website";
      break;
    }
    default: return neutral;               // VERIFIED_OFFICIAL_WEBSITE (no material issue), WEBSITE_UNVERIFIED, IDENTITY_UNCERTAIN
  }
  const conf = r.identityConfidence ?? 0;
  const primary = status === "no_website" ? "we could not find a website for the business"
    : status === "broken_website" ? (sentences[0] ?? "the website was not working when we checked")
    : sentences[0] ?? "";
  return {
    website_status: status, research_verified: true, verified_issues: status === "no_website" ? [] : sentences, primary_issue: primary,
    research_confidence: conf >= 0.85 ? "high" : conf >= 0.7 ? "medium" : "low",
    recommended_service: r.recommendedPackage ? PACKAGE_LABEL[r.recommendedPackage] ?? "" : "",
  };
}

/** The Retell dynamic variables for one call (all strings, Retell requirement). Internal metadata is never included. */
export function dynamicVariables(i: { leadId: string; businessName: string | null; contactName: string | null; industry: string | null; websiteUrl: string | null; environment: string; ctx: SpokenContext }): Record<string, string> {
  const first = (i.contactName ?? "").trim().split(/\s+/)[0] ?? "";
  const clean = (s: string | null, max: number) => (s ?? "").replace(/[\r\n\t{}]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);
  return {
    lead_id: i.leadId,
    business_name: clean(i.businessName, 120),
    first_name: /^[\p{L}'-]{1,40}$/u.test(first) ? first : "",
    industry: clean(i.industry, 80),
    // Only a research-verified official URL, never a guessed one; empty for "no website" and unverified leads.
    website_url: i.ctx.research_verified && i.ctx.website_status !== "no_website" && /^https?:\/\/[^\s]{3,200}$/.test(i.websiteUrl ?? "") ? i.websiteUrl! : "",
    website_status: i.ctx.website_status,
    verified_issue: clean(i.ctx.primary_issue, 200),
    recommended_service: clean(i.ctx.recommended_service, 80),
    research_verified: String(i.ctx.research_verified),
    crestmont_env: i.environment,
  };
}

// ───────────── Compliance gate ─────────────

export interface SalesGateFacts {
  phoneE164: string | null;
  /** Recipient IANA time zone (from research state or CRM location); null = unknown → blocked. */
  timeZone: string | null;
  /** Two-letter state, for state-specific window narrowing; null = unknown → blocked. */
  state: string | null;
  onDnc: boolean;
  complianceApproval: { approvedBy: string; approvedAt: string; reference: string } | null;
  consent: { id: string; lineType: "mobile" | "landline" | "voip"; evidenceRef: string; capturedAt: string } | null;
  dncScrub: { result: "clear" | "listed"; checkedAt: string } | null;
  emailOrPhoneSuppressedInCrm: boolean;
  leadStage: string | null;
  leadMerged: boolean;
  /** The number is shared with another business record and nobody confirmed who it reaches. */
  sharedPhoneConflict: boolean;
  attemptsSoFar: number;
  maxAttempts: number;
}

export interface SalesGate { eligible: boolean; reasons: string[] }

export const DNC_SCRUB_MAX_DAYS = 31;
const OPEN_STAGES = new Set(["new", "qualified", "quote_required", "quote_sent", "negotiation"]);

/**
 * Every condition must hold; any unknown is a block. The research gate (outboundEligibility, PR #48) is reused for its
 * shared conditions so the two can never disagree. `existingCrmRecord` is false here on purpose: this gate runs on the
 * CRM lead itself (the research gate blocks *prospects* that already belong to a CRM record).
 */
export function salesCallEligibility(f: SalesGateFacts, now: Date = new Date()): SalesGate {
  const base = outboundEligibility({
    phoneE164: f.phoneE164, timeZone: f.timeZone, onDnc: f.onDnc, existingCrmRecord: false, sharedPhoneConflict: f.sharedPhoneConflict,
    complianceApproval: f.complianceApproval, marketingConsentEvidence: f.consent ? f.consent.evidenceRef : null,
    lineType: f.consent?.lineType ?? "unknown",
  });
  const reasons = [...base.reasons];
  if (f.phoneE164 && !f.phoneE164.startsWith("+1")) reasons.push("Only US (+1) numbers can be called");
  if (!f.state) reasons.push("Recipient state not established (needed for state calling rules)");
  if (!f.dncScrub) reasons.push(`No National Do Not Call Registry check recorded for this number in the last ${DNC_SCRUB_MAX_DAYS} days`);
  else if (f.dncScrub.result !== "clear") reasons.push("Number is listed on a do-not-call registry");
  else if (now.getTime() - Date.parse(f.dncScrub.checkedAt) > DNC_SCRUB_MAX_DAYS * 86_400_000) reasons.push(`Do-not-call registry check is older than ${DNC_SCRUB_MAX_DAYS} days`);
  if (f.emailOrPhoneSuppressedInCrm) reasons.push("The CRM has this contact suppressed");
  if (f.leadMerged) reasons.push("Lead was merged into another lead");
  if (!f.leadStage || !OPEN_STAGES.has(f.leadStage)) reasons.push(`Lead stage ${f.leadStage ?? "unknown"} is not open for sales calls`);
  if (f.attemptsSoFar >= f.maxAttempts) reasons.push(`Attempt limit reached (${f.maxAttempts})`);
  return { eligible: reasons.length === 0, reasons };
}

// ───────────── Calling window (recipient-local) ─────────────

/** Window per state in minutes after local midnight. Default 10:00–19:00; Maine (automated calls) 10:00–17:00. */
const STATE_WINDOW: Record<string, [number, number]> = { ME: [600, 1020] };
const DEFAULT_WINDOW: [number, number] = [600, 1140];

function localParts(at: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(at).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), weekday: p.weekday as string, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** US federal holidays (observed) for a year, as YYYY-MM-DD. */
export function federalHolidays(y: number): Set<string> {
  const ymd = (m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const nth = (m: number, weekday: number, n: number) => { const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7; };
  const last = (m: number, weekday: number) => { const days = new Date(Date.UTC(y, m, 0)).getUTCDate(); const lastDow = new Date(Date.UTC(y, m - 1, days)).getUTCDay(); return days - ((lastDow - weekday + 7) % 7); };
  const observed = (m: number, d: number) => { const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); const t = new Date(Date.UTC(y, m - 1, d + (dow === 6 ? -1 : dow === 0 ? 1 : 0))); return t.toISOString().slice(0, 10); };
  return new Set([observed(1, 1), ymd(1, nth(1, 1, 3)), ymd(2, nth(2, 1, 3)), ymd(5, last(5, 1)), observed(6, 19), observed(7, 4), ymd(9, nth(9, 1, 1)),
    ymd(10, nth(10, 1, 2)), observed(11, 11), ymd(11, nth(11, 4, 4)), observed(12, 25)]);
}

export function withinSalesWindow(at: Date, tz: string | null, state: string | null): boolean {
  if (!tz || !state) return false;
  let lp;
  try { lp = localParts(at, tz); } catch { return false; }
  if (lp.weekday === "Sat" || lp.weekday === "Sun") return false;
  const date = `${lp.y}-${String(lp.m).padStart(2, "0")}-${String(lp.d).padStart(2, "0")}`;
  if (federalHolidays(lp.y).has(date)) return false;
  const [open, close] = STATE_WINDOW[state] ?? DEFAULT_WINDOW;
  return lp.minutes >= open && lp.minutes < close;
}

/** Next instant (15-minute steps, up to 8 days ahead) at which the window opens, or null. */
export function nextSalesWindow(from: Date, tz: string | null, state: string | null): Date | null {
  if (!tz || !state) return null;
  const step = 15 * 60_000;
  let t = new Date(Math.ceil(from.getTime() / step) * step);
  for (let i = 0; i < 8 * 96; i++, t = new Date(t.getTime() + step)) if (withinSalesWindow(t, tz, state)) return t;
  return null;
}

// ───────────── Final call outcome ─────────────

export interface OutcomeFacts {
  disconnectionReason: string | null;
  callStatus: string | null;
  talked: boolean;
  dncRecorded: boolean;
  paymentConfirmed: boolean;
  checkoutSent: boolean;
  consultationBooked: boolean;
  followUpScheduled: boolean;
  agentDisposition: string | null;
  analysisOutcome: string | null;
}

const NO_ANSWER = new Set(["dial_no_answer", "dial_busy", "user_declined"]);
const FAILED = new Set(["dial_failed", "invalid_destination", "telephony_provider_permission_denied", "telephony_provider_unavailable", "sip_routing_error", "marked_as_spam", "network_blocked", "concurrency_limit_reached", "scam_detected"]);

/**
 * Most reliable source first: platform-recorded facts (DNC, Stripe-verified payment, links sent, bookings), then
 * telephony (Retell's disconnection_reason), then the agent's own disposition, then Retell post-call analysis (an LLM
 * guess, used only when nothing better exists). A conversation with no classifiable result is "unclassified" and a
 * person decides — it is never guessed as interested or not.
 */
export function resolveOutcome(f: OutcomeFacts): { outcome: SalesOutcome; source: string } {
  const reason = f.disconnectionReason ?? "";
  if (f.dncRecorded || reason === "user_requested_dnc") return { outcome: "do_not_call", source: f.dncRecorded ? "record_do_not_call" : "retell_disconnection_reason" };
  if (f.paymentConfirmed) return { outcome: "payment_confirmed", source: "stripe_webhook" };
  if (f.checkoutSent) return { outcome: "checkout_sent", source: "sales_checkout_links" };
  if (f.consultationBooked) return { outcome: "consultation_booked", source: "consultations" };
  if (reason === "voicemail_reached") return { outcome: "voicemail", source: "retell_disconnection_reason" };
  if (NO_ANSWER.has(reason)) return { outcome: "no_answer", source: "retell_disconnection_reason" };
  if (f.callStatus === "error" || reason.startsWith("error") || FAILED.has(reason)) return { outcome: "technical_failure", source: "retell_disconnection_reason" };
  if (f.agentDisposition && (AGENT_DISPOSITIONS as readonly string[]).includes(f.agentDisposition)) return { outcome: f.agentDisposition as SalesOutcome, source: "agent_disposition" };
  if (f.followUpScheduled) return { outcome: "follow_up_requested", source: "sales_followups" };
  if (!f.talked) return { outcome: "no_answer", source: "no_conversation" };
  if (f.analysisOutcome && (AGENT_DISPOSITIONS as readonly string[]).includes(f.analysisOutcome)) return { outcome: f.analysisOutcome as SalesOutcome, source: "retell_post_call_analysis" };
  return { outcome: "unclassified", source: "none" };
}
