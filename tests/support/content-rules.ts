// Shared truthfulness rules for public content (WEB-009), used by the local crawl and the staging crawl.
/** Truthfulness checks beyond the catalogue's PROHIBITED_CLAIMS (§12: no fabricated counts, awards, ratings, history, scarcity). */
export const FABRICATION = [/\b\d[\d,]*\+?\s+(happy |satisfied )?(clients|customers|businesses served|projects delivered)\b/i, /award[- ]winning/i, /\b\d+\+?\s+years? (of experience|in business)\b/i,
  /★|\b\d(\.\d)?\s*(\/\s*5|stars?)\b/i, /only \d+ (spots?|slots?) (left|remaining)/i, /offer ends|limited time|countdown/i, /(?<!\b(not|never|no|cannot) )\bguarantee(d|s)?\b/i,
  /24\/7 (human|live|staffed)/i, /attorney[- ](approved|reviewed)(?! )/i];


/**
 * AI Receptionist claims that describe capability Crestmont has not built as if it were a built-in feature
 * (CREST-GAP-051). Visitor-facing copy outside the clearly labelled scripted demo must word these as custom,
 * per-client configuration on the client's chosen provider — or not make them at all.
 */
export const RECEPTIONIST_UNBUILT: RegExp[] = [
  /\bSMS\b/, /\btext(ed)? (message )?confirmation/i, /sends? (you |them )?a (text|confirmation)/i,
  /picks up on the first ring/i, /answers every call/i, /every call answered/i, /never miss/i,
  /real availability/i, /checks availability/i, /books? (and|or) reschedules?/i, /\bbook(s|ing)? (and reschedul\w+ )?appointments in your calendar/i,
  /warm transfer/i, /transferred live/i, /transfers? (them|the call|urgent calls?) to the right person/i,
  /creates or updates the contact/i, /every call (ends with|updates)/i, /one call, every system updated/i, /update your CRM\b/i,
  /confirms upcoming appointments/i, /reminds customers/i, /calls back leads/i, /Outbound: confirmations/i,
  /inbound (and|&) outbound (calls|voice agents)/i,
];
