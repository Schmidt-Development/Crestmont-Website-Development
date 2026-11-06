// Founder Calendar ↔ Google Calendar (Founder directive 2026-11-06, priority 1). Google is a local fake: these tests prove
// the platform's behaviour, not the live Google account (that is verified with the Founder's own consent on staging).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, TEST_PASSWORD } from "./support/app.ts";
import type { Env } from "../src/app/context.ts";
import { defaultVoiceConfig, saveVoiceConfig, type VoiceConfig } from "../src/services/voice-settings.ts";
import * as sched from "../src/services/voice-scheduling.ts";
import * as FC from "../src/services/founder-calendar.ts";
import { GOOGLE_SCOPES, FOUNDER_CALENDAR_NAME } from "../src/adapters/google-calendar.ts";
import { promptBehaviourFindings } from "../src/services/retell-inbound-audit.ts";
import { OutboxEmail } from "../src/adapters/email.ts";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7)));
const ENV = { GOOGLE_OAUTH_CLIENT_ID: "client-test.apps.googleusercontent.com", GOOGLE_OAUTH_CLIENT_SECRET: "client-secret-test", MFA_ENCRYPTION_KEY: KEY };
const FOUNDER = "founder.test@example.com";
const NOW = new Date("2026-11-02T14:00:00Z"); // Monday 09:00 ET
const ROUTE = { calendar: "founder_callback" as const, founderReason: "customer_requested_founder" as const };

function idToken(email: string) { const b = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, ""); return `${b({ alg: "none" })}.${b({ email, email_verified: true })}.sig`; }

/** A minimal Google: OAuth token endpoint, calendar list/insert/get, free/busy and events with client ids. */
function fakeGoogle(o: { account?: string; existing?: boolean; busy?: { start: string; end: string }[]; failFreeBusy?: boolean; scope?: string } = {}) {
  const calendars = new Map<string, { summary: string; timeZone: string }>();
  if (o.existing) calendars.set("existing_cal@group.calendar.google.com", { summary: FOUNDER_CALENDAR_NAME, timeZone: "America/New_York" });
  const events = new Map<string, Record<string, any>>();
  const log: string[] = [];
  const state = { failFreeBusy: !!o.failFreeBusy };
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url), m = init.method ?? "GET";
    log.push(`${m} ${u.pathname}`);
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
    if (u.hostname === "oauth2.googleapis.com" && u.pathname === "/token") {
      const p = new URLSearchParams(String(init.body));
      if (p.get("grant_type") === "authorization_code") {
        if (p.get("code") !== "good-code" || !p.get("code_verifier")) return json({ error: "invalid_grant" }, 400);
        return json({ access_token: "at_1", refresh_token: "rt_secret_value", expires_in: 3600, scope: o.scope ?? GOOGLE_SCOPES.join(" "), id_token: idToken(o.account ?? FOUNDER) });
      }
      return p.get("refresh_token") === "rt_secret_value" ? json({ access_token: "at_2", expires_in: 3600 }) : json({ error: "invalid_grant" }, 400);
    }
    if (u.pathname === "/revoke") return json({});
    if (u.pathname === "/calendar/v3/users/me/calendarList") return json({ items: [...calendars].map(([id, c]) => ({ id, summary: c.summary, accessRole: "owner" })) });
    if (u.pathname === "/calendar/v3/calendars" && m === "POST") { const b = JSON.parse(String(init.body)); const id = `crestmont_${calendars.size}@group.calendar.google.com`; calendars.set(id, { summary: b.summary, timeZone: b.timeZone }); return json({ id }); }
    const calGet = /^\/calendar\/v3\/calendars\/([^/]+)$/.exec(u.pathname);
    if (calGet && m === "GET") { const c = calendars.get(decodeURIComponent(calGet[1])); return c ? json({ id: decodeURIComponent(calGet[1]), ...c }) : json({ error: { message: "Not Found" } }, 404); }
    if (u.pathname === "/calendar/v3/freeBusy") {
      if (state.failFreeBusy) return json({ error: { message: "Backend Error" } }, 503);
      const b = JSON.parse(String(init.body));
      return json({ calendars: Object.fromEntries(b.items.map((i: { id: string }) => [i.id, { busy: i.id === "primary" ? (o.busy ?? []) : [] }])) });
    }
    const ev = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(u.pathname);
    if (ev) {
      const b = JSON.parse(String(init.body ?? "{}"));
      if (m === "POST") { if (events.has(b.id)) return json({ error: { message: "duplicate" } }, 409); events.set(b.id, { ...b, calendar: decodeURIComponent(ev[1]) }); return json({ id: b.id }); }
      if (m === "PATCH") { const id = decodeURIComponent(ev[2]); if (!events.has(id)) return json({ error: { message: "Not Found" } }, 404); events.set(id, { ...events.get(id), ...b }); return json({ id }); }
    }
    return json({ error: { message: `unexpected ${m} ${u.pathname}` } }, 500);
  }) as unknown as typeof fetch;
  return { f, calendars, events, log, state };
}

function cfg(): VoiceConfig {
  const c = defaultVoiceConfig();
  c.timezone = "America/New_York";
  for (const d of ["mon", "tue", "wed", "thu", "fri"] as const) c.hours[d] = [{ open: "09:00", close: "17:00" }];
  c.scheduling.enabled = true;
  c.scheduling.founder_hours.tue = [{ open: "10:00", close: "12:00" }];
  return c;
}

async function app(g = fakeGoogle()) {
  const t = await createTestApp(ENV as Partial<Env>);
  t.env.overrides = { storage: t.storage, now: () => NOW, fetch: g.f } as Env["overrides"];
  const owner = await createStaff(t.db, "owner");
  await saveVoiceConfig(t.db, owner.id, cfg());
  const deps = { db: t.db, env: t.env, fetch: g.f, mail: { email: new OutboxEmail(t.db), db: t.db, settings: {} }, baseUrl: "https://staging.example" } as unknown as FC.FounderDeps;
  const connect = async () => {
    const url = new URL(await FC.startConnect(t.db, t.env, owner.id, "https://staging.example/oauth/google/founder-calendar/callback", FOUNDER, NOW));
    return FC.completeConnect(t.db, t.env, g.f, { userId: owner.id, state: url.searchParams.get("state")!, code: "good-code", redirectUri: "https://staging.example/oauth/google/founder-calendar/callback", timeZone: "America/New_York", expectedAccount: FOUNDER, now: NOW });
  };
  return { ...t, owner, g, deps, connect };
}

test("[VOICE-003] [SEC-002] Google connection: minimal scopes, PKCE + one-time state, wrong account refused, token stored encrypted, dedicated calendar created once", async () => {
  const t = await app();
  const url = new URL(await FC.startConnect(t.db, t.env, t.owner.id, "https://staging.example/cb", FOUNDER, NOW));
  assert.deepEqual(url.searchParams.get("scope")!.split(" "), [...GOOGLE_SCOPES]);
  assert.ok(!GOOGLE_SCOPES.includes("https://www.googleapis.com/auth/calendar" as never), "never the full calendar scope");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("access_type"), "offline");
  // A state that was not issued to this Owner, or reused, is refused.
  await assert.rejects(FC.completeConnect(t.db, t.env, t.g.f, { userId: t.owner.id, state: "forged", code: "good-code", redirectUri: "https://staging.example/cb", timeZone: "America/New_York", expectedAccount: FOUNDER }), FC.FounderCalendarError);
  const c = await t.connect();
  assert.equal(c.account_email, FOUNDER);
  assert.equal(c.calendar_created, 1);
  assert.equal([...t.g.calendars.values()].filter((x) => x.summary === FOUNDER_CALENDAR_NAME).length, 1);
  assert.doesNotMatch(c.refresh_token_sealed, /rt_secret_value/, "the refresh token is never stored in plaintext");
  assert.equal(c.last_check_ok, 1, c.last_check_detail ?? "");
  // Wrong Google account: refused and revoked, nothing stored.
  const t2 = await app(fakeGoogle({ account: "someone.else@example.com" }));
  await assert.rejects(t2.connect(), /must belong to founder\.test@example\.com/);
  assert.equal(await FC.loadConnection(t2.db), null);
  assert.ok(t2.g.log.includes("POST /revoke"));
  // A permission withheld on the consent screen is refused.
  const t3 = await app(fakeGoogle({ scope: "openid email" }));
  await assert.rejects(t3.connect(), /did not grant every permission/);
});

test("[VOICE-003] an existing dedicated calendar is reused, never duplicated", async () => {
  const t = await app(fakeGoogle({ existing: true }));
  const c = await t.connect();
  assert.equal(c.calendar_id, "existing_cal@group.calendar.google.com");
  assert.equal(c.calendar_created, 0);
  assert.equal(t.g.calendars.size, 1);
});

test("[VOICE-003] real availability: Google busy time blocks Founder slots (AI capacity untouched); if Google cannot be read no Founder time is offered", async () => {
  // The Founder is busy Tuesday 10:00–11:00 ET on their primary calendar.
  const g = fakeGoogle({ busy: [{ start: "2026-11-03T15:00:00Z", end: "2026-11-03T16:00:00Z" }] });
  const t = await app(g);
  await t.connect();
  const adapter = await FC.founderAdapter(t.db, t.env, g.f);
  assert.equal(adapter.connected, true);
  const av = await sched.availability(t.db, cfg(), NOW, adapter, { calendar: "founder_callback", limit: 10 });
  assert.ok(av.available);
  const starts = av.slots.map((s) => s.startsAt);
  assert.ok(!starts.includes("2026-11-03T15:00:00.000Z") && !starts.includes("2026-11-03T15:30:00.000Z"), "busy on Google: not offered");
  assert.ok(starts.includes("2026-11-03T16:00:00.000Z"), "free on Google: offered");
  await assert.rejects(sched.book(t.db, cfg(), NOW, adapter, { name: "P", phone: "+16145550101", startsAt: "2026-11-03T15:00:00.000Z", leadId: null, callId: null, isTest: true, source: "ai_receptionist", calendar: ROUTE }), sched.SlotUnavailableError);
  // AI Outbound Calendar availability never consults Google.
  const before = g.log.filter((x) => x.endsWith("/freeBusy")).length;
  await sched.availability(t.db, cfg(), NOW, adapter, { calendar: "ai_follow_up" });
  assert.equal(g.log.filter((x) => x.endsWith("/freeBusy")).length, before);
  // Google down: Founder availability is refused, never guessed.
  g.state.failFreeBusy = true;
  const down = await sched.availability(t.db, cfg(), NOW, await FC.founderAdapter(t.db, t.env, g.f), { calendar: "founder_callback" });
  assert.deepEqual(down, { available: false, reason: "calendar_unavailable" });
});

test("[VOICE-003] [EMAIL-002] every Founder appointment is mirrored once to Google and emailed once per event: booked, rescheduled, confirmed, cancelled", async () => {
  const t = await app();
  await t.connect();
  const adapter = await FC.founderAdapter(t.db, t.env, t.g.f);
  const { booking } = await sched.book(t.db, cfg(), NOW, adapter, { name: "Fay Prospect", phone: "+16145550102", email: "fay@example.com", startsAt: "2026-11-03T16:00:00.000Z", topic: "Asked for the Founder about a portal", leadId: null, callId: null, isTest: true, source: "ai_receptionist", calendar: ROUTE });
  assert.equal(booking.status, "requested", "the Founder's confirmation requirement is kept");
  await FC.founderAppointmentChanged(t.deps, booking.id, "booked");
  await FC.founderAppointmentChanged(t.deps, booking.id, "booked"); // retry
  const id1 = await FC.googleEventId(booking.id);
  assert.equal(t.g.events.size, 1, "a retry never creates a second event");
  assert.equal(t.g.events.get(id1)!.status, "tentative");
  assert.equal(t.g.events.get(id1)!.start.dateTime, "2026-11-03T16:00:00.000Z");
  const mails = async (event: string) => (await t.db.prepare(`SELECT COUNT(*) AS n FROM email_deliveries WHERE template = 'founder_appointment' AND to_email = ? AND idempotency_key LIKE ?`).bind(FOUNDER, `%:${event}`).first<{ n: number }>())!.n;
  assert.equal(await mails("booked"), 1, "one email for the booking despite the retry");
  // Reschedule: the new appointment gets its own event; the old one is cancelled on Google.
  const moved = await sched.reschedule(t.db, cfg(), NOW, adapter, booking, "2026-11-10T16:00:00.000Z", { kind: "ai" });
  await FC.founderAppointmentChanged(t.deps, moved.id, "rescheduled");
  assert.equal(t.g.events.get(id1)!.status, "cancelled");
  const id2 = await FC.googleEventId(moved.id);
  assert.equal(t.g.events.get(id2)!.start.dateTime, "2026-11-10T16:00:00.000Z");
  assert.equal(await mails("rescheduled"), 1);
  // Founder confirms, then cancels.
  await sched.decide(t.db, t.owner.id, moved.id, "confirm", "");
  await FC.founderAppointmentChanged(t.deps, moved.id, "confirmed");
  assert.equal(t.g.events.get(id2)!.status, "confirmed");
  await sched.decide(t.db, t.owner.id, moved.id, "cancel", "Founder unavailable");
  await FC.founderAppointmentChanged(t.deps, moved.id, "cancelled");
  assert.equal(t.g.events.get(id2)!.status, "cancelled");
  assert.equal(t.g.events.size, 2);
  assert.equal(await mails("confirmed"), 1);
  assert.equal(await mails("cancelled"), 1);
  const row = (await t.db.prepare(`SELECT google_sync_status, google_event_id FROM consultations WHERE id = ?`).bind(moved.id).first<{ google_sync_status: string; google_event_id: string }>())!;
  assert.deepEqual({ ...row }, { google_sync_status: "synced", google_event_id: id2 });
  // The event holds the appointment details on the Founder's own calendar; the prospect is never invited.
  assert.ok(!("attendees" in t.g.events.get(id2)!));
});

test("[VOICE-003] a Google failure never loses the booking: it is marked failed and retried by the scheduled job; AI appointments never touch Google", async () => {
  const t = await app();
  await t.connect();
  const adapter = await FC.founderAdapter(t.db, t.env, t.g.f);
  const { booking } = await sched.book(t.db, cfg(), NOW, adapter, { name: "Gus", phone: "+16145550103", startsAt: "2026-11-03T16:30:00.000Z", leadId: null, callId: null, isTest: true, source: "ai_receptionist", calendar: ROUTE });
  await t.db.prepare(`UPDATE google_calendar_connection SET refresh_token_sealed = 'v1:broken:broken'`).run();
  await FC.founderAppointmentChanged(t.deps, booking.id, "booked");
  assert.equal((await t.db.prepare(`SELECT google_sync_status FROM consultations WHERE id = ?`).bind(booking.id).first<{ google_sync_status: string }>())!.google_sync_status, "failed");
  assert.equal((await t.db.prepare(`SELECT status FROM consultations WHERE id = ?`).bind(booking.id).first<{ status: string }>())!.status, "requested", "the booking stands");
  await t.connect(); // Founder reconnects
  const r = await FC.retryFounderSync(t.deps);
  assert.match(r.detail, /1 Founder appointment/);
  assert.equal(t.g.events.size, 1);
  // An AI Outbound Calendar appointment is never mirrored to Google.
  const ai = await sched.book(t.db, cfg(), NOW, adapter, { name: "AI cb", phone: "+16145550104", startsAt: "2026-11-03T18:00:00.000Z", leadId: null, callId: null, isTest: true, source: "ai_receptionist" });
  await FC.founderAppointmentChanged(t.deps, ai.booking.id, "booked");
  assert.equal(t.g.events.size, 1);
});

test("[SEC-002] [OWN-002] the Google connection page and actions are Owner-only; the page never shows a token", async () => {
  const t = await app();
  await t.connect();
  const c = t.client(); await c.login(t.owner.email, TEST_PASSWORD, t.owner.secret);
  const page = await (await c.get("/staff/calendars/founder-callback/google")).text();
  assert.match(page, /data-google-connected/);
  assert.match(page, new RegExp(FOUNDER.replace(/\./g, "\\.")));
  assert.doesNotMatch(page, /rt_secret_value|v1:/);
  const admin = await createStaff(t.db, "administrator", "admin-gc@crestmont.test");
  const a = t.client(); await a.login(admin.email, TEST_PASSWORD, admin.secret);
  for (const [m, p] of [["GET", "/staff/calendars/founder-callback/google"], ["POST", "/staff/calendars/founder-callback/google/check"], ["POST", "/staff/calendars/founder-callback/google/disconnect"], ["GET", "/oauth/google/founder-calendar/callback?state=x&code=y"]] as const) {
    const res = m === "GET" ? await a.get(p) : await a.post(p, {});
    assert.equal(res.status, 403, `${m} ${p}`);
  }
});

test("[VOICE-004] Retell prompt audit: 24/7 selling, after-hours conflicts, intake and Founder-on-request are judged from the live text", () => {
  const good = "You are available 24/7. Buying starts with our project intake form. Book callbacks with schedule_consultation. Only if the caller specifically asks for the Founder, pass wants_founder true.";
  assert.ok(promptBehaviourFindings(good).every((f) => f.status === "pass"), JSON.stringify(promptBehaviourFindings(good)));
  const bad = "Outside business hours only take a message. Tell callers we are closed. {{business_open_now}}";
  const f = Object.fromEntries(promptBehaviourFindings(bad).map((x) => [x.check, x]));
  assert.equal(f["prompt: sells 24/7"].status, "fail");
  assert.equal(f["prompt: no after-hours limits"].status, "fail");
  assert.match(f["prompt: no after-hours limits"].detail, /says Crestmont is closed \(1\).*branches on business_open_now/);
  assert.doesNotMatch(JSON.stringify(promptBehaviourFindings(bad)), /Tell callers/, "the prompt text is never echoed");
});
