// Business time zone (CREST-GAP-094). The site displays dates in Eastern time (src/lib/html.ts), so dates a person
// picks — a proposal's valid-until date, a CRM follow-up due date — mean the END of that day in America/New_York,
// not midnight UTC (which is 7–8 pm Eastern the evening before).
export const BUSINESS_TIME_ZONE = "America/New_York";

/** YYYY-MM-DD of `d` in the business time zone. */
export function businessDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** UTC offset in minutes (e.g. -240 for EDT) of the business time zone at instant `ms`. */
function offsetMinutes(ms: number): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TIME_ZONE, timeZoneName: "longOffset" }).formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
}

/** ISO instant of 23:59:59.999 on `date` (YYYY-MM-DD) in the business time zone. DST changes happen at 2 am, so the
 *  offset at local noon is the offset in force at the end of that day. */
export function endOfBusinessDay(date: string): string {
  const noonUtc = Date.parse(`${date}T12:00:00.000Z`);
  if (Number.isNaN(noonUtc)) throw new Error(`Invalid date ${date}`);
  const off = offsetMinutes(noonUtc + 5 * 3600e3);
  return new Date(Date.parse(`${date}T23:59:59.999Z`) - off * 60e3).toISOString();
}
