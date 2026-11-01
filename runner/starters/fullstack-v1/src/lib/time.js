// Time-zone arithmetic without libraries (Intl only). All stored instants are UTC ISO strings; business hours,
// dates and blackout days are wall-clock values in the business's IANA time zone. DST is handled by asking Intl
// for the zone's offset AT the instant in question, never by assuming a fixed offset.

const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
    dtfCache.set(tz, f);
  }
  return f;
}

export function validTimeZone(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return typeof tz === "string" && tz.includes("/"); } catch { return false; }
}

/** Wall-clock parts of an instant in a zone. */
export function zonedParts(instantMs, tz) {
  const p = Object.fromEntries(dtf(tz).formatToParts(new Date(instantMs)).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second, weekday: p.weekday };
}

/** Zone offset (ms) at an instant: local wall time minus UTC. */
export function offsetAt(instantMs, tz) {
  const p = zonedParts(instantMs, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instantMs / 1000) * 1000;
}

/**
 * UTC instant for a wall-clock date+time in a zone, or null when that wall time does not exist (the spring-forward
 * gap). For an ambiguous time (fall-back hour) the EARLIER instant is returned.
 */
export function zonedToUtc(date, time, tz) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const candidates = new Set();
  for (const probe of [wall - 36e5 * 14, wall, wall + 36e5 * 14]) candidates.add(wall - offsetAt(probe, tz));
  const ok = [...candidates].filter((t) => { const p = zonedParts(t, tz); return p.year === y && p.month === m && p.day === d && p.hour === hh && p.minute === mm; });
  return ok.length ? Math.min(...ok) : null;
}

/** Local calendar date (YYYY-MM-DD) of an instant in a zone. */
export function localDate(instantMs, tz) {
  const p = zonedParts(instantMs, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/** Weekday key of a calendar date (independent of zone: it is the date itself). */
export function weekdayOf(date) {
  const [y, m, d] = date.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function isDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
export const isTime = (s) => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
export const minutes = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
export const hhmm = (mins) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
export const iso = (ms) => new Date(ms).toISOString();
