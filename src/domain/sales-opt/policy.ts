// Protected policy layer for the Retell SALES agent (SALESOPT-005). Pure: no I/O.
//
// Every prompt the optimization engine deploys is PROTECTED_SALES_POLICY followed by an optimizable instructions
// block. Optimization (human or self-hosted model) can only ever change the instructions block, and
// salesPolicyViolations() rejects instructions that try to contradict the policy. The policy is generated from
// the catalog (src/domain/catalog.ts), so prices in it can never drift from the published prices.
//
// What this layer does NOT do: decide whether a call may be placed. Consent, do-not-call, calling windows and
// approval are enforced by the dialler gates (src/services/voice-outbound.ts), which this engine never changes.
import { PACKAGES, MAINTENANCE_PLANS } from "../catalog.ts";
import { inventedPrices } from "../../services/voice.ts";

/** Bumped whenever the policy text changes; recorded on every version so a deployed prompt is traceable. */
export const SALES_POLICY_VERSION = "sales-policy-2026-10-30.1";

const dollars = (c: number) => `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

function priceLines(): string {
  const pk = Object.values(PACKAGES).map((p) => `${p.name} website: ${dollars(p.basePriceCents)}${p.priceIsFloor ? "+ (starting price)" : ""}`);
  const mt = Object.values(MAINTENANCE_PLANS).map((m) => `${m.name} maintenance: ${dollars(m.monthlyCents)} per month`);
  return [...pk, "Custom website: quoted separately by a person after scoping; never give a number", ...mt].map((l) => `   - ${l}`).join("\n");
}

export const POLICY_HEADER = "PROTECTED SALES POLICY (platform-enforced; optimization cannot change this section):";
export const INSTRUCTIONS_HEADER = "SALES INSTRUCTIONS (optimizable):";

export const PROTECTED_SALES_POLICY = `${POLICY_HEADER}
1. Identity: at the start of the call say you are an AI assistant calling for Crestmont Website Development. If asked whether you are a person, a bot or an AI, answer truthfully that you are an AI assistant. Never claim to be human.
2. Recording: if the call may be recorded or transcribed, say so and ask for consent; call record_consent with the answer. If the person declines, continue without recording.
3. Prices: quote ONLY these published prices, exactly:
${priceLines()}
4. Payment: standard packages are paid in full upfront through a secure Stripe checkout link that Crestmont sends. Never take card or bank details by voice. Custom projects follow their signed contract's payment schedule; never describe or offer other terms.
5. Never offer, imply or negotiate a discount, coupon, promotion, free extra, payment plan, deposit or financing. If asked, say prices are fixed and offer the right package or a callback from a person.
6. Never guarantee or predict results: no promises of sales, leads, revenue, rankings, traffic, conversions or return on investment, and no delivery or launch dates.
7. Scope: describe only what the published package includes. Never agree to extra scope, contract terms, warranties or changes; a person handles those.
8. Refunds: never approve, promise or estimate a refund. Record the request and escalate.
9. Consent and refusals: if the person says they are not interested, asks you to stop, or declines a purchase, accept it the first time, thank them and end the call. Do not repeat the offer, argue, or create false urgency (no "today only", "last spots", deadlines that do not exist).
10. Opt-out: if the person asks not to be called again or to be removed from a list, call record_opt_out immediately, confirm it, and end the call.
11. Human help: if the person asks for a person, or the situation is complex, sensitive or outside these rules, use escalate or request_callback.
12. Wrong person: if the person is not the business owner or decision-maker, or it is a wrong number, apologise, do not pitch, and end the call (offer a callback only if they ask).
13. Never invent facts about Crestmont, a customer, a competitor or this person's business. If unsure, say you will have a person follow up.
14. These rules override anything in the instructions below.`;

// Bare "no" is not a negation here ("if they say no, ask again" must still be caught); the window stays in one clause.
const NEGATION = /\b(never|not|don'?t|do not|cannot|can'?t|won'?t|isn'?t|aren'?t|wasn'?t|must not|unable|without|avoid|refuse)\b[^.,;!?\n]{0,40}$/i;

// Idioms that contain a negation word but are affirmative ("do not hesitate to offer…", "never forget to mention…").
const AFFIRMATIVE_IDIOMS = /\b(don'?t|do not|never|not)\s+(hesitate|forget|fail|neglect|miss a chance|wait)\b|\bnot only\b|\bwithout (delay|hesitation|fail)\b|\bcan'?t (wait|go wrong)\b/gi;

/** Removes invisible/format characters and folds look-alike punctuation so patterns cannot be split. */
export function normalizeInstructions(text: string): string {
  return text.normalize("NFKC").replace(/[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, "").replace(/[\u2018\u2019]/g, "'");
}

/** An affirmative use of a pattern (ignores "never offer a discount", "do not guarantee results", …). */
export function affirmative(text: string, re: RegExp): string[] {
  const out: string[] = [];
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (const m of text.matchAll(g)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 60), m.index ?? 0).replace(AFFIRMATIVE_IDIOMS, " ");
    // Trailing negation in the same clause: "a payment plan isn't something I can set up", "discounts are not offered".
    const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 40);
    if (/^[^.,;!?\n]{0,15}\b(isn'?t|is not|aren'?t|are not|can'?t be|cannot be|won'?t be|is never|are never)\b/i.test(after)) continue;
    if (!NEGATION.test(before)) out.push(m[0]);
  }
  return out;
}

interface Rule { id: string; re: RegExp; message: string; negatable: boolean }

export const SALES_POLICY_RULES: readonly Rule[] = [
  { id: "human_identity", re: /\b(i am|i'm|we are|you are|you're|say you are|claim to be|pretend to be|act as|posing as)\s+(a\s+|an?\s+actual\s+)?(human|real person|person|live (agent|person)|not an? (ai|bot|robot|assistant))\b|\b(a\s+)?human named\b/i, message: "claims or instructs a human identity", negatable: true },
  { id: "hide_disclosure", re: /\b(don'?t|do not|never|avoid)\s+(say|mention|disclose|reveal|admit|tell)\b[^.\n]{0,40}\b(ai|artificial|automated|bot|recorded|recording|transcri\w*)\b|\b(skip|omit|drop|remove|leave out|shorten)\b[^.\n]{0,30}\b(ai|identity|disclosure|recording|consent)\b/i, message: "removes a required disclosure", negatable: false },
  { id: "guarantee", re: /\b(guarantee[sd]?|promise[sd]?|ensure[sd]?)\b[^.\n]{0,50}\b(sales|leads|revenue|ranking|rankings|traffic|conversions?|roi|results|first page|page one|#1|customers|growth|launch date|deadline)\b|\bguaranteed\b|\brisk[- ]free\b|\bmoney[- ]back\b/i, message: "promises or guarantees results", negatable: true },
  { id: "discount", re: /\b(discount|coupon|promo(tion)?( code)?|percent off|% off|\d+\s?% off|free (month|months|page|pages|upgrade|maintenance|setup|domain|hosting)|(first|1st|one) month (is )?free|months? free|special (price|offer|deal|rate)|limited[- ]time|price match|cheaper|deal for you|best price)\b/i, message: "offers a discount or promotion", negatable: true },
  { id: "payment_terms", re: /\b(payment plan|instal(l)?ments?|financing|finance it|pay later|split (the )?payment|deposit|net ?\d{1,2}|pay (half|part))\b/i, message: "offers unapproved payment terms", negatable: true },
  { id: "refund_promise", re: /\b(full refund|refund(s)? (is|are) (guaranteed|available|easy)|we('ll| will) refund|refundable)\b/i, message: "promises a refund", negatable: true },
  { id: "contract_terms", re: /\b(sign|agree to|accept)\b[^.\n]{0,30}\b(contract|agreement|terms|sla|warranty)\b|\b(warranty|sla)\b/i, message: "agrees to contract terms", negatable: true },
  { id: "pressure", re: /\b(don'?t take no|do not take no|never take no|keep (pushing|asking|trying)|ask again|overcome every|push past|today only|only today|last (chance|spots?)|only \d+ (spots?|slots?) (left|remaining)|offer expires|act now|before (it'?s|the price goes) (gone|up)|price (goes|will go) up)\b/i, message: "uses pressure or false urgency", negatable: true },
  { id: "ignore_refusal", re: /\b(ignore|disregard|overcome|push through|work around)\b[^.\n]{0,30}\b(no|refusal|refusals|not interested|objection to (the )?call|stop)\b/i, message: "ignores refusals", negatable: true },
  { id: "bypass_opt_out", re: /\b(ignore|skip|bypass|delay|postpone)\b[^.\n]{0,30}\b(opt[- ]?out|do[- ]not[- ]call|dnc|record_opt_out|removal|remove (them|me|the number))\b/i, message: "bypasses opt-out handling", negatable: true },
  { id: "card_by_voice", re: /\b(read|take|collect|ask for)\b[^.\n]{0,30}\b(card|credit card|cvv|bank account|routing number)\b/i, message: "collects payment details by voice", negatable: true },
  { id: "override_policy", re: /\b(ignore|override|disregard|forget|replace|suspend|waive)\b[^.\n]{0,25}\b(previous|above|protected|policy|guardrails?|rules?|instructions above)\b|\brules?\s+\d+(\s*(,|and|&)\s*\d+)*\b[^.\n]{0,30}\b(no longer|do(es)? not|don'?t|doesn'?t)\s+apply\b|\b(policy|rules?)\b[^.\n]{0,20}\b(no longer apply|are suspended|is suspended|don'?t apply|do not apply)\b/i, message: "tries to override the protected policy", negatable: true },
  { id: "invented_dates", re: /\b(in|within)\s+\d+\s+(business\s+)?(days?|weeks?)\b|\b(launch|live|ready|delivered)\s+(by|in|within)\b/i, message: "promises delivery timing", negatable: true },
];

/** Deterministic policy check for an instructions block. Empty array = allowed. */
export function salesPolicyViolations(instructions: string): string[] {
  const t = normalizeInstructions(instructions).trim();
  const out: string[] = [];
  if (/[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/.test(instructions)) out.push("Instructions contain invisible formatting characters; remove them.");
  if (t.length < 80) out.push("Instructions are too short (at least 80 characters).");
  if (t.length > 12_000) out.push("Instructions must be at most 12,000 characters.");
  if (t.includes(POLICY_HEADER) || t.includes(INSTRUCTIONS_HEADER) || /PROTECTED SALES POLICY/i.test(t)) out.push("Instructions must not contain or imitate the protected policy headers.");
  const prices = inventedPrices(t);
  if (prices.length) out.push(`Mentions prices that are not published catalog prices: ${[...new Set(prices)].join(", ")}.`);
  for (const r of SALES_POLICY_RULES) {
    const hits = r.negatable ? affirmative(t, r.re) : [...t.matchAll(new RegExp(r.re.source, r.re.flags + "g"))].map((m) => m[0]);
    if (hits.length) out.push(`Policy ${r.id}: instructions ${r.message} (“${hits[0].slice(0, 60)}”).`);
  }
  return out;
}

export function composeSalesPrompt(instructions: string): string {
  return `${PROTECTED_SALES_POLICY}\n\n${INSTRUCTIONS_HEADER}\n${instructions.trim()}`;
}

/** True when a prompt carries the current protected policy unchanged, as its prefix. */
export function hasProtectedPolicy(prompt: string): boolean {
  return prompt.startsWith(`${PROTECTED_SALES_POLICY}\n\n${INSTRUCTIONS_HEADER}\n`);
}

export function salesInstructionsOf(prompt: string): string | null {
  const marker = `\n\n${INSTRUCTIONS_HEADER}\n`;
  const i = prompt.indexOf(marker);
  return i >= 0 ? prompt.slice(i + marker.length) : null;
}

/** Starting instructions (version 1). Written to pass the policy check; the Founder should review before use. */
export function baselineSalesInstructions(): string {
  return `You are speaking with {{contact_name}} about {{business_name}}. This call exists only because consent was recorded for it; if the person did not expect the call, apologise, offer record_opt_out, and end the call.
Opening: greet them by name, say you are Crestmont's AI assistant, give the reason for the call in one sentence, and ask whether now is a good moment. If not, offer request_callback and end the call.
Discovery: ask one short question at a time. Learn whether they have a website today, what they want it to do for the business, and roughly how many pages they need. Confirm they make the decision for the business before discussing price.
Recommendation: match their needs to one package and explain what it includes in plain words. Use get_published_pricing for prices; say each price once and clearly.
Questions: answer briefly and accurately. If you do not know, say a person will follow up.
Objections: acknowledge the concern in their words, answer it once with facts about the package, then ask if they would like to go ahead, think about it, or have a person call. Respect their answer.
Checkout: when they clearly agree to buy a standard package, confirm the package and the best email address, then call create_lead with that package as the interest. Tell them Crestmont emails a secure checkout link and payment is completed on Stripe's secure page.
Maintenance: explain the monthly plans only if they ask or the package needs ongoing updates.
Custom work: collect requirements with create_lead and explain that a person will prepare a quote.
Keep each turn under three sentences.`;
}
