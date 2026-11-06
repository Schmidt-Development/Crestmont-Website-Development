// Google Calendar API adapter (Founder Calendar, Founder directive 2026-11-06). Plain fetch, no SDK, no paid service.
//
// Scopes — the minimum for the job, requested once by the Founder's consent on /staff/calendars/founder-callback/google:
//   openid email                                            which Google account was connected (notification address)
//   https://www.googleapis.com/auth/calendar.app.created    create the dedicated calendar and manage events on it ONLY
//   https://www.googleapis.com/auth/calendar.freebusy       busy times of the Founder's primary + dedicated calendar
//                                                           (free/busy reveals no titles, attendees or descriptions)
//   https://www.googleapis.com/auth/calendar.calendarlist.readonly   find an existing dedicated calendar to reuse
// The platform can never read the content of the Founder's personal events: free/busy returns start/end times only.
export const GOOGLE_SCOPES = [
  "openid", "email",
  "https://www.googleapis.com/auth/calendar.app.created",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
] as const;
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
export const FOUNDER_CALENDAR_NAME = "Crestmont — Founder Appointments";

export class GoogleCalendarError extends Error {
  status: number | null;
  constructor(msg: string, status: number | null = null) { super(msg); this.status = status; }
}

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : {});
const str = (x: unknown) => (typeof x === "string" ? x : null);

async function request(f: typeof fetch, url: string, init: RequestInit, what: string): Promise<{ status: number; json: Obj }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const r = await f(url, { ...init, signal: ac.signal });
    const text = await r.text();
    let json: Obj = {};
    try { json = obj(JSON.parse(text)); } catch { /* not JSON */ }
    return { status: r.status, json };
  } catch (e) {
    throw new GoogleCalendarError(`${what}: ${(e as Error).name === "AbortError" ? "timed out" : "network error"}`);
  } finally { clearTimeout(timer); }
}

const errOf = (j: Obj) => str(obj(j.error).message) ?? str(j.error_description) ?? str(j.error) ?? "error";

export function authorizationUrl(i: { clientId: string; redirectUri: string; state: string; codeChallenge: string; loginHint?: string | null }): string {
  const q = new URLSearchParams({
    client_id: i.clientId, redirect_uri: i.redirectUri, response_type: "code", scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline", prompt: "consent", include_granted_scopes: "false", state: i.state,
    code_challenge: i.codeChallenge, code_challenge_method: "S256",
  });
  if (i.loginHint) q.set("login_hint", i.loginHint);
  return `${GOOGLE_AUTH_URL}?${q}`;
}

export interface TokenSet { accessToken: string; refreshToken: string | null; scope: string; email: string | null; expiresIn: number }

/** The id_token comes straight from Google's token endpoint over TLS, so its payload is read without re-verifying. */
function emailFromIdToken(idToken: string | null): string | null {
  if (!idToken) return null;
  try {
    const part = idToken.split(".")[1] ?? "";
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="))) as Obj;
    return json.email_verified === true || json.email_verified === "true" ? str(json.email)?.toLowerCase() ?? null : null;
  } catch { return null; }
}

export async function exchangeCode(f: typeof fetch, i: { clientId: string; clientSecret: string; redirectUri: string; code: string; codeVerifier: string }): Promise<TokenSet> {
  const r = await request(f, GOOGLE_TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: i.code, client_id: i.clientId, client_secret: i.clientSecret, redirect_uri: i.redirectUri, code_verifier: i.codeVerifier }) }, "token exchange");
  if (r.status !== 200 || !str(r.json.access_token)) throw new GoogleCalendarError(`Google refused the authorisation code: ${errOf(r.json)}`, r.status);
  return { accessToken: str(r.json.access_token)!, refreshToken: str(r.json.refresh_token), scope: str(r.json.scope) ?? "", email: emailFromIdToken(str(r.json.id_token)), expiresIn: Number(r.json.expires_in) || 3600 };
}

export async function refreshAccessToken(f: typeof fetch, i: { clientId: string; clientSecret: string; refreshToken: string }): Promise<string> {
  const r = await request(f, GOOGLE_TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: i.refreshToken, client_id: i.clientId, client_secret: i.clientSecret }) }, "token refresh");
  if (r.status !== 200 || !str(r.json.access_token)) throw new GoogleCalendarError(`Google refused the stored authorisation (${errOf(r.json)}); reconnect the Founder Calendar`, r.status);
  return str(r.json.access_token)!;
}

export async function revoke(f: typeof fetch, token: string): Promise<void> {
  await request(f, GOOGLE_REVOKE_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) }, "revoke").catch(() => undefined);
}

const auth = (token: string, json = false): HeadersInit => ({ authorization: `Bearer ${token}`, ...(json ? { "content-type": "application/json" } : {}) });

export async function findCalendarByName(f: typeof fetch, token: string, name: string): Promise<{ id: string; accessRole: string } | null> {
  let pageToken: string | null = null;
  for (let i = 0; i < 10; i++) {
    const r = await request(f, `${CALENDAR_API}/users/me/calendarList?maxResults=250${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, { headers: auth(token) }, "calendar list");
    if (r.status !== 200) throw new GoogleCalendarError(`Could not list calendars: ${errOf(r.json)}`, r.status);
    for (const c of (Array.isArray(r.json.items) ? r.json.items : []).map(obj)) if (str(c.summary) === name && !c.deleted) return { id: str(c.id)!, accessRole: str(c.accessRole) ?? "" };
    pageToken = str(r.json.nextPageToken);
    if (!pageToken) return null;
  }
  return null;
}

export async function createCalendar(f: typeof fetch, token: string, name: string, timeZone: string): Promise<string> {
  const r = await request(f, `${CALENDAR_API}/calendars`, { method: "POST", headers: auth(token, true), body: JSON.stringify({ summary: name, timeZone, description: "Appointments a prospect asked to have with the Founder, booked by Crestmont's AI agents. Managed by the Crestmont platform." }) }, "create calendar");
  if (r.status !== 200 || !str(r.json.id)) throw new GoogleCalendarError(`Could not create the calendar: ${errOf(r.json)}`, r.status);
  return str(r.json.id)!;
}

export async function getCalendar(f: typeof fetch, token: string, calendarId: string): Promise<{ id: string; summary: string | null; timeZone: string | null } | null> {
  const r = await request(f, `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}`, { headers: auth(token) }, "get calendar");
  if (r.status === 404) return null;
  if (r.status !== 200) throw new GoogleCalendarError(`Could not read the calendar: ${errOf(r.json)}`, r.status);
  return { id: str(r.json.id)!, summary: str(r.json.summary), timeZone: str(r.json.timeZone) };
}

/** Busy intervals across the given calendars (start/end only — never titles or details). */
export async function freeBusy(f: typeof fetch, token: string, calendarIds: string[], fromMs: number, toMs: number): Promise<{ start: number; end: number }[]> {
  const r = await request(f, `${CALENDAR_API}/freeBusy`, { method: "POST", headers: auth(token, true),
    body: JSON.stringify({ timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(), items: calendarIds.map((id) => ({ id })) }) }, "free/busy");
  if (r.status !== 200) throw new GoogleCalendarError(`Free/busy lookup failed: ${errOf(r.json)}`, r.status);
  const out: { start: number; end: number }[] = [];
  for (const [id, c] of Object.entries(obj(r.json.calendars))) {
    const errors = obj(c).errors;
    if (Array.isArray(errors) && errors.length) throw new GoogleCalendarError(`Free/busy lookup failed for ${id === "primary" ? "the primary calendar" : "the Founder calendar"}: ${str(obj(errors[0]).reason) ?? "error"}`);
    for (const b of (Array.isArray(obj(c).busy) ? (obj(c).busy as unknown[]) : []).map(obj)) {
      const s = Date.parse(str(b.start) ?? ""), e = Date.parse(str(b.end) ?? "");
      if (Number.isFinite(s) && Number.isFinite(e) && e > s) out.push({ start: s, end: e });
    }
  }
  return out;
}

export interface EventBody { id: string; summary: string; description: string; start: string; end: string; timeZone: string; status: "tentative" | "confirmed" | "cancelled" }

/** Creates the event with a client-chosen id (stable per appointment), or updates it when it already exists. */
export async function upsertEvent(f: typeof fetch, token: string, calendarId: string, e: EventBody): Promise<string> {
  const body = {
    id: e.id, summary: e.summary, description: e.description, status: e.status, transparency: "opaque", visibility: "private",
    start: { dateTime: e.start, timeZone: e.timeZone }, end: { dateTime: e.end, timeZone: e.timeZone },
    reminders: { useDefault: false, overrides: [{ method: "email", minutes: 60 }, { method: "popup", minutes: 15 }] },
  };
  const base = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`;
  const ins = await request(f, `${base}?sendUpdates=none`, { method: "POST", headers: auth(token, true), body: JSON.stringify(body) }, "create event");
  if (ins.status === 200) return str(ins.json.id) ?? e.id;
  if (ins.status !== 409) throw new GoogleCalendarError(`Could not create the event: ${errOf(ins.json)}`, ins.status);
  // 409: an event with this id exists (a retry, or a status change): update it in place — never a second event.
  const { id: _id, ...patch } = body;
  const up = await request(f, `${base}/${encodeURIComponent(e.id)}?sendUpdates=none`, { method: "PATCH", headers: auth(token, true), body: JSON.stringify(patch) }, "update event");
  if (up.status !== 200) throw new GoogleCalendarError(`Could not update the event: ${errOf(up.json)}`, up.status);
  return e.id;
}
