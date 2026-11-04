// Protected copy of the business-configuration validator used by the acceptance gates. The gates never load the
// website's own modules (src/), so a website cannot change how its configuration is judged; src/lib/config.js keeps
// the runtime copy. A foundation test keeps the two in agreement on the shipped examples.
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export function validTimeZone(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return typeof tz === "string" && tz.includes("/"); } catch { return false; }
}
export function isDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
export const isTime = (s) => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/**
 * Is a postal code or city inside the configured service area? Identical to src/lib/config.js, which serves the
 * live requests; kept here so the gates can judge the website without loading the website's own modules.
 */
export function inServiceArea(c, postalCode, city) {
  const a = c?.serviceArea;
  if (!a) return true;
  const zip5 = String(postalCode ?? "").slice(0, 5);
  if (Array.isArray(a.postalCodes) && a.postalCodes.length && zip5 && a.postalCodes.includes(zip5)) return true;
  if (Array.isArray(a.cities) && city && a.cities.some((x) => x.toLowerCase() === String(city).trim().toLowerCase())) return true;
  return false;
}

export const FEATURE_KEYS = ["contact", "quotes", "booking", "payments", "customer_accounts", "notifications", "admin"];

/**
 * Facts in business.config.json that may only ever come FROM THE CUSTOMER, and where the build brief carries
 * each one. Gate A promises that "missing facts are never invented"; until the configuration was compared with
 * the brief that promise was unenforceable, because the gate only ever asked whether a value was PRESENT. A
 * builder that honestly recorded `null` failed and escalated, while one that made a plausible value up passed —
 * the gate rewarded fabrication over honesty (real defect, job bld_b62360ebf30bf50493cc724d, 2026-11-03, which
 * invented New York and Detroit postal codes for a junk-removal company in Lansing, Michigan).
 */
const CUSTOMER_FACTS = [
  { path: ["business", "phone"], brief: ["business", "publicPhone"], label: "public contact phone" },
  { path: ["business", "email"], brief: ["business", "publicEmail"], label: "public contact email" },
  { path: ["serviceArea"], brief: ["business", "serviceArea"], label: "service area" },
];
const dig = (o, keys) => keys.reduce((v, k) => (v == null ? v : v[k]), o);
const blank = (v) => v == null || (typeof v === "string" && !v.trim());

/**
 * Problems in a configuration (empty = valid). `missing` lists facts that must come from the customer; `invented`
 * lists facts the website states that the customer never gave.
 *
 * `brief` is the BRIEF.json content (with customerData). Without it the fabrication check cannot run, and that is
 * reported as a problem rather than quietly treated as a pass.
 */
export function validateConfig(c, brief = null) {
  const problems = [];
  const missing = [];
  const invented = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };
  if (!c || typeof c !== "object") return { problems: ["business.config.json is not an object"], missing };
  need(c.schema === "crestmont.business-config/1", "schema must be crestmont.business-config/1");
  need(c.configured === true, "configured must be true once the intake has been applied (the starter ships unconfigured)");
  const b = c.business ?? {};
  for (const [k, label] of [["name", "business name"], ["description", "business description"], ["industry", "industry"], ["email", "public contact email"], ["phone", "public contact phone"]]) {
    if (b[k] === null) missing.push(label);
    else need(typeof b[k] === "string" && b[k].trim().length > 1, `business.${k} is required (or null when the customer has not provided it)`);
  }
  need(validTimeZone(b.timeZone), "business.timeZone must be an IANA zone such as America/New_York");
  if (b.address) need(typeof b.address === "object", "business.address must be an object");
  const features = c.features ?? {};
  for (const k of Object.keys(features)) need(FEATURE_KEYS.includes(k), `unknown feature ${k}`);
  const services = Array.isArray(c.services) ? c.services : [];
  const ids = new Set();
  for (const s of services) {
    need(/^[a-z0-9][a-z0-9-]{1,40}$/.test(String(s.id)), `service id ${s.id} must be lowercase letters, digits and dashes`);
    need(!ids.has(s.id), `duplicate service id ${s.id}`); ids.add(s.id);
    need(typeof s.name === "string" && s.name.length > 1, `service ${s.id} needs a name`);
    if (s.priceCents !== null && s.priceCents !== undefined) need(Number.isInteger(s.priceCents) && s.priceCents >= 0, `service ${s.id}: priceCents must be a whole number of cents`);
    if (s.bookable) need(Number.isInteger(s.durationMinutes) && s.durationMinutes >= 5, `service ${s.id}: a bookable service needs durationMinutes`);
    if (s.payable) need(Number.isInteger(s.priceCents) && s.priceCents > 0, `service ${s.id}: a payable service needs a priceCents > 0 (server-side price)`);
  }
  if (features.booking) {
    need(services.some((s) => s.bookable), "booking is enabled but no service is bookable");
    const k = c.booking ?? {};
    need(Number.isInteger(k.slotIntervalMinutes) && k.slotIntervalMinutes >= 5, "booking.slotIntervalMinutes is required");
    need(Number.isInteger(k.leadTimeMinutes) && k.leadTimeMinutes >= 0, "booking.leadTimeMinutes is required");
    need(Number.isInteger(k.bufferMinutes) && k.bufferMinutes >= 0, "booking.bufferMinutes is required");
    need(Number.isInteger(k.maxDaysAhead) && k.maxDaysAhead >= 1 && k.maxDaysAhead <= 365, "booking.maxDaysAhead must be 1-365");
    need(Number.isInteger(k.cancellationNoticeHours) && k.cancellationNoticeHours >= 0, "booking.cancellationNoticeHours is required");
    for (const d of k.blackoutDates ?? []) need(isDate(d), `booking.blackoutDates: ${d} is not a date`);
    const resources = Array.isArray(k.resources) ? k.resources : [];
    need(resources.length > 0, "booking.resources needs at least one resource (crew, room, staff member)");
    for (const r of resources) need(Number.isInteger(r.capacity ?? 1) && (r.capacity ?? 1) >= 1, `resource ${r.id}: capacity must be ≥ 1`);
  }
  if (features.booking || c.hours) {
    const h = c.hours;
    if (h === null) missing.push("business hours");
    else {
      need(h && typeof h === "object", "hours is required for booking (or null when the customer has not provided it)");
      for (const day of Object.keys(h ?? {})) {
        need(WEEKDAYS.includes(day), `hours: unknown day ${day}`);
        for (const r of h[day] ?? []) need(isTime(r.open) && isTime(r.close) && r.open < r.close, `hours.${day}: ${JSON.stringify(r)} is not a valid open/close range`);
      }
    }
  }
  if (features.payments) {
    const p = c.payments ?? {};
    need(p.provider === "stripe", "payments.provider must be stripe");
    need(/^[a-z]{3}$/.test(String(p.currency)), "payments.currency must be a 3-letter currency code");
    need(p.accountOwner === "customer", "payments.accountOwner must be \"customer\": the business's own Stripe account (never Crestmont's)");
    need(services.some((s) => s.payable), "payments are enabled but no service is payable");
  }
  // A service area is customer information only when the business GOES TO THE CUSTOMER: a quote for on-site
  // work, or a booking that needs an address. A salon or a shop that customers come to has no service area,
  // and demanding one would be a false failure.
  //
  // Within that scope, null and absent now mean the same thing. They used to differ: null reported the fact as
  // missing, while leaving the key out meant "serves everywhere" and passed — so the honest spelling escalated
  // and omission sailed through, which rewarded the builder that said least.
  if (features.quotes === true || c.booking?.requireAddress === true) {
    const a = c.serviceArea;
    if (a === null || a === undefined) missing.push("service area");
    else need(Array.isArray(a.postalCodes) || Array.isArray(a.cities), "serviceArea needs postalCodes or cities");
  } else if (c.serviceArea) {
    need(Array.isArray(c.serviceArea.postalCodes) || Array.isArray(c.serviceArea.cities), "serviceArea needs postalCodes or cities");
  }

  // ── Fabrication check: a fact the customer never gave may not appear in the website's configuration ──
  const cd = brief && typeof brief === "object" ? (brief.customerData ?? brief) : null;
  if (!cd) {
    problems.push("the build brief was not available, so facts in business.config.json could not be checked against what the customer actually provided");
  } else {
    for (const f of CUSTOMER_FACTS) {
      const told = dig(cd, f.brief);
      const shown = dig(c, f.path);
      if (blank(told) && !blank(shown)) {
        invented.push(f.label);
        problems.push(`${f.path.join(".")} states a ${f.label} the customer never provided (${JSON.stringify(shown).slice(0, 120)}). `
          + "Missing facts are requested from the customer, never invented: set it to null so the build escalates.");
      }
    }
  }
  return { problems, missing, invented };
}
