// Shared truthfulness rules for public content (WEB-009), used by the local crawl and the staging crawl.
/** Truthfulness checks beyond the catalogue's PROHIBITED_CLAIMS (§12: no fabricated counts, awards, ratings, history, scarcity). */
export const FABRICATION = [/\b\d[\d,]*\+?\s+(happy |satisfied )?(clients|customers|businesses served|projects delivered)\b/i, /award[- ]winning/i, /\b\d+\+?\s+years? (of experience|in business)\b/i,
  /★|\b\d(\.\d)?\s*(\/\s*5|stars?)\b/i, /only \d+ (spots?|slots?) (left|remaining)/i, /offer ends|limited time|countdown/i, /(?<!\b(not|never|no|cannot) )\bguarantee(d|s)?\b/i,
  /24\/7 (human|live|staffed)/i, /attorney[- ](approved|reviewed)(?! )/i];

