// Shared helpers for the foundation tests. They run against THIS website's business.config.json: a feature the
// configuration enables is tested for real (never skipped); a feature it does not enable is skipped, and the
// acceptance gates check that no required feature's tests were skipped.
import { CONFIG, enabled } from "../../src/lib/config.js";
import { settings as _s } from "../../src/lib/db.js";
import { isDate, localDate, weekdayOf } from "../../src/lib/time.js";
export { app, fakeStripe } from "../../scripts/lib/harness.mjs";
export { CONFIG, enabled };

export const off = (f) => (enabled(CONFIG, f) ? false : `feature ${f} is not enabled in business.config.json`);

/** First bookable service. */
export const bookable = () => (CONFIG.services ?? []).find((s) => s.bookable && !s.payable) ?? (CONFIG.services ?? []).find((s) => s.bookable);
export const payable = () => (CONFIG.services ?? []).find((s) => s.bookable && s.payable);

/** Next open local date at least `minDays` after `nowMs` (business hours, blackout dates, booking window). */
export function openDate(nowMs, minDays = 2) {
  const tz = CONFIG.business.timeZone;
  for (let i = minDays; i < (CONFIG.booking?.maxDaysAhead ?? 30); i++) {
    const d = localDate(nowMs + i * 864e5, tz);
    if (isDate(d) && (CONFIG.hours?.[weekdayOf(d)] ?? []).length && !(CONFIG.booking?.blackoutDates ?? []).includes(d)) return d;
  }
  throw new Error("no open date in the booking window (check hours and blackout dates)");
}

export const person = (i = 1) => ({ name: `Test Customer ${i}`, email: `customer${i}@example.test`, phone: "555-0100", postalCode: CONFIG.serviceArea?.postalCodes?.[0] ?? undefined, address: CONFIG.booking?.requireAddress ? "1 Test Street" : undefined });
