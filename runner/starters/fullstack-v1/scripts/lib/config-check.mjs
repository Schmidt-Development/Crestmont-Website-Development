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

export const FEATURE_KEYS = ["contact", "quotes", "booking", "payments", "customer_accounts", "notifications", "admin"];

/** Problems in a configuration (empty = valid). `missing` lists facts that must come from the customer. */
export function validateConfig(c) {
  const problems = [];
  const missing = [];
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
  if (features.quotes || features.booking) {
    const a = c.serviceArea;
    if (a === null) missing.push("service area");
    else if (a !== undefined) need(Array.isArray(a.postalCodes) || Array.isArray(a.cities), "serviceArea needs postalCodes or cities");
  }
  return { problems, missing };
}
