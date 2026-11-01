// Crestmont inbound Retell receptionist — the eight register functions (docs/voice/RETELL-INBOUND-FUNCTION-REGISTER.md):
// crm_customer_lookup, crm_upsert_lead, get_packages_pricing, create_checkout_session, check_payment_status,
// schedule_consultation, create_support_ticket, send_customer_email.
// FIXTURES ONLY: every request is an HMAC-signed fixture through the real router (POST /api/webhooks/retell/functions)
// into an in-memory D1. Email goes to the development outbox; Stripe is never called (no checkout session is created by
// these functions). Nothing here is evidence of a live Retell, Stripe or Resend connection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer } from "./support/app.ts";
import type { Env } from "../src/app/context.ts";
import { signRetell } from "../src/adapters/retell.ts";
import { defaultVoiceConfig, saveVoiceConfig, type VoiceConfig } from "../src/services/voice-settings.ts";
import { INBOUND_FUNCTIONS, MAX_EMAILS_PER_CALL } from "../src/services/voice.ts";
import { PACKAGES } from "../src/domain/catalog.ts";
import { newId, nowIso } from "../src/lib/db.ts";

const KEY = "key_fixture_retell_inbound_0001";
const MON_9AM = new Date("2026-11-02T14:00:00Z"); // Monday 09:00 America/Detroit
const URL_FN = "/api/webhooks/retell/functions";
type Db = Env["DB"];
const count = async (db: Db, sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<{ n: number }>())!.n;

function configured(scheduling = false): VoiceConfig {
  const c = defaultVoiceConfig();
  c.timezone = "America/Detroit";
  for (const d of ["mon", "tue", "wed", "thu", "fri"] as const) c.hours[d] = [{ open: "09:00", close: "17:00" }];
  c.scheduling.enabled = scheduling;
  return c;
}

async function app(opts: { stripe?: boolean; budget?: boolean; now?: Date } = {}) {
  const t = await createTestApp({ RETELL_INBOUND_API_KEY: KEY, ...(opts.stripe ? { STRIPE_SECRET_KEY: "sk_test_fixture_inbound_0001" } : {}) });
  t.env.overrides = { storage: t.storage, now: () => opts.now ?? MON_9AM };
  const owner = await createStaff(t.db, "owner", "owner@crestmontwebsitedevelopment.com");
  if (opts.budget !== false) await t.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('voice.monthly_budget_usd', '50', ?)`).bind(nowIso()).run();
  const c = t.client();
  const raw = async (body: string, headers: Record<string, string>) => c.request("POST", URL_FN, { body, headers: { "content-type": "application/json", ...headers } });
  const call = async (callId: string, name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const body = JSON.stringify({ name, call: { call_id: callId, call_type: "phone_call", from_number: "+15550100123", to_number: "+15550109999", direction: "inbound", ...extra }, args });
    const res = await raw(body, { "x-retell-signature": await signRetell(KEY, body) });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return { ...t, owner, call, raw };
}

// ───────────── Authentication (all eight) ─────────────

test("[VOICE-003] [SEC-002] every inbound register function refuses unsigned, wrongly signed and stale requests (fixture)", async () => {
  const t = await app();
  for (const name of INBOUND_FUNCTIONS) {
    const body = JSON.stringify({ name, call: { call_id: `c_auth_${name}`, call_type: "phone_call" }, args: {} });
    assert.equal((await t.raw(body, {})).status, 401, `${name}: no signature`);
    assert.equal((await t.raw(body, { "x-retell-signature": await signRetell("key_wrong_000000000000", body) })).status, 401, `${name}: wrong key`);
    assert.equal((await t.raw(body, { "x-retell-signature": await signRetell(KEY, body, Date.now() - 10 * 60_000) })).status, 401, `${name}: stale timestamp`);
    const tampered = JSON.stringify({ name, call: { call_id: `c_auth_${name}`, call_type: "phone_call" }, args: { email: "x@example.com" } });
    assert.equal((await t.raw(tampered, { "x-retell-signature": await signRetell(KEY, body) })).status, 401, `${name}: body changed after signing`);
  }
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM voice_events`), 0, "no refused request reached the voice service");
  const noKey = await createTestApp({});
  const body = JSON.stringify({ name: "get_packages_pricing", call: { call_id: "c_nokey" }, args: {} });
  const r = await noKey.client().request("POST", URL_FN, { body, headers: { "x-retell-signature": await signRetell(KEY, body) } });
  assert.equal(r.status, 401, "fails closed when RETELL_INBOUND_API_KEY is not set");
});

test("[VOICE-003] unknown function names and invalid JSON are rejected with 422; responses never contain the key (fixture)", async () => {
  const t = await app();
  assert.equal((await t.call("c_unk", "issue_refund", {})).status, 422);
  const bad = "{not json";
  assert.equal((await t.raw(bad, { "x-retell-signature": await signRetell(KEY, bad) })).status, 422);
  const p = await t.call("c_key", "get_packages_pricing", {});
  assert.ok(!JSON.stringify(p.json).includes(KEY));
});

// ───────────── 1. crm_customer_lookup ─────────────

test("[VOICE-004] [SEC-002] crm_customer_lookup gives the identical non-disclosing answer for a real customer and a stranger (fixture)", async () => {
  const t = await app();
  const cust = await createCustomer(t.db, "real.customer@example.com");
  await t.db.prepare(`INSERT INTO contacts (id, name, email, phone, user_id, created_at) VALUES (?,?,?,?,?,?)`).bind(newId("ct"), "Pat Customer", cust.email, "+15550100123", cust.id, nowIso()).run();
  const known = await t.call("c_lk1", "crm_customer_lookup", { name: "Pat Customer", email: cust.email, phone: "+15550100123" });
  const unknown = await t.call("c_lk2", "crm_customer_lookup", { name: "Nobody", email: "nobody@example.com", phone: "+15550100999" });
  assert.equal(known.status, 200);
  assert.deepEqual(known.json, unknown.json, "same body whether or not the account exists");
  assert.equal(known.json.identity_verified, false);
  assert.equal(known.json.account_details_available, false);
  assert.ok(!JSON.stringify(known.json).includes("Acme"), "no organization name");
  assert.equal((await t.call("c_lk3", "crm_customer_lookup", { email: "not-an-email" })).status, 422, "invalid input");
});

// ───────────── 2. crm_upsert_lead ─────────────

test("[CRM-001] [VOICE-003] crm_upsert_lead uses CRM intake dedupe: the same caller on two calls continues one lead; retry is idempotent (fixture)", async () => {
  const t = await app();
  const args = { name: "Lee Lead", phone: "+15550100140", email: "lee@example.com", interest: "business", requirements: "A 10 page site for a dental practice" };
  const a = await t.call("c_up1", "crm_upsert_lead", args);
  assert.equal(a.status, 200);
  assert.equal(a.json.lead_saved, true);
  assert.deepEqual((await t.call("c_up1", "crm_upsert_lead", args)).json, a.json, "identical Retell retry replays the stored result");
  const b = await t.call("c_up2", "crm_upsert_lead", { ...args, requirements: "Also wants online booking" });
  assert.deepEqual(Object.keys(b.json).sort(), Object.keys(a.json).sort(), "same shape when matched: does not reveal the caller is known");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM contacts WHERE email = 'lee@example.com'`), 1, "no duplicate contact");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE c.email = 'lee@example.com' AND l.merged_into_lead_id IS NULL`), 1, "no duplicate lead");
  assert.equal((await t.call("c_up3", "crm_upsert_lead", { name: "X", interest: "business", requirements: "short" })).status, 422, "name too short");
  assert.equal((await t.call("c_up4", "crm_upsert_lead", { name: "No Contact", interest: "business", requirements: "Needs a website soon" })).status, 422, "phone or email required");
  assert.equal((await t.call("c_up5", "crm_upsert_lead", { ...args, interest: "free_website" })).status, 422, "interest outside the enum");
  // Card numbers spoken into free text never reach the CRM.
  await t.call("c_up6", "crm_upsert_lead", { ...args, phone: "+15550100141", email: "card@example.com", requirements: "my card is 4242 4242 4242 4242 please charge it" });
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM leads WHERE message LIKE '%4242 4242%'`), 0);
});

// ───────────── 3. get_packages_pricing ─────────────

test("[CAT-001] [VOICE-004] get_packages_pricing returns catalog prices only, no add-ons, and ignores invented price arguments (fixture)", async () => {
  const t = await app();
  const r = await t.call("c_pr", "get_packages_pricing", { starter_price: 1 });
  assert.equal(r.status, 200);
  const cents = Object.fromEntries(r.json.pricing.packages.map((p: { name: string; priceCents: number }) => [p.name, p.priceCents]));
  assert.deepEqual(cents, Object.fromEntries(Object.values(PACKAGES).map((p) => [p.name, p.basePriceCents])));
  assert.deepEqual(r.json.pricing.addOns, []);
  assert.deepEqual(r.json.pricing.checkoutPackages, ["Starter", "Business", "Premium"]);
  assert.ok(Array.isArray(r.json.pricing.maintenancePurchasableOnline));
  assert.ok(!("entitlements" in r.json.pricing.maintenance[0]), "maintenance entitlements are never returned");
});

// ───────────── 4. create_checkout_session + 5. check_payment_status ─────────────

test("[PAY-001] [VOICE-003] create_checkout_session refuses honestly when Stripe is not configured (fixture)", async () => {
  const t = await app({ stripe: false });
  const r = await t.call("c_co0", "create_checkout_session", { package: "business", name: "Bo Buyer", email: "bo@example.com" });
  assert.equal(r.json.link_sent, false);
  assert.equal(r.json.reason, "payments_not_configured");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_deliveries`), 0);
});

test("[PAY-001] [VOICE-003] create_checkout_session emails the existing secure checkout link once; no card data, no direct Stripe session, reference only by email (fixture)", async () => {
  const t = await app({ stripe: true });
  const args = { package: "business", name: "Bo Buyer", email: "Bo@Example.com" };
  const r = await t.call("c_co1", "create_checkout_session", { ...args, price: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.link_sent, true);
  assert.equal(r.json.price, "$2,499", "catalog price; the invented price argument is ignored");
  const link = (await t.db.prepare(`SELECT reference, email, package_id, lead_id FROM voice_checkout_links`).first<{ reference: string; email: string; package_id: string; lead_id: string }>())!;
  assert.equal(link.email, "bo@example.com");
  assert.equal(link.package_id, "business");
  assert.ok(link.lead_id, "CRM lead linked");
  assert.ok(!JSON.stringify(r.json).includes(link.reference), "the reference is never spoken: it is only in the email");
  const mail = (await t.db.prepare(`SELECT d.template, m.text_body FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE d.to_email = 'bo@example.com'`).first<{ template: string; text_body: string }>())!;
  assert.equal(mail.template, "voice_followup");
  assert.match(mail.text_body, /http:\/\/crestmont\.test\/checkout\/business/);
  assert.match(mail.text_body, new RegExp(link.reference));
  assert.match(mail.text_body, /\$2,499/);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM orders`), 0, "no order or Stripe session until the customer signs in and accepts the agreements");
  // Retry and repeat request: one link, one email.
  assert.deepEqual((await t.call("c_co1", "create_checkout_session", { ...args, price: 1 })).json, r.json);
  const again = await t.call("c_co1", "create_checkout_session", args);
  assert.equal(again.json.already_sent, true);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_deliveries WHERE to_email = 'bo@example.com'`), 1);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM voice_checkout_links`), 1);
  // Invalid inputs.
  assert.equal((await t.call("c_co2", "create_checkout_session", { ...args, package: "enterprise" })).status, 422, "only approved packages");
  assert.equal((await t.call("c_co2", "create_checkout_session", { ...args, email: "nope" })).status, 422);
  assert.equal((await t.call("c_co2", "create_checkout_session", { package: "starter", name: "Bo" })).status, 422, "email required");
});

test("[PAY-001] [PAY-004] check_payment_status needs reference + email, locks after 3 misses and reads only webhook-confirmed invoice state (fixture)", async () => {
  const t = await app({ stripe: true });
  await t.call("c_ps1", "create_checkout_session", { package: "starter", name: "Pia Payer", email: "pia@example.com" });
  const ref = (await t.db.prepare(`SELECT reference, created_at FROM voice_checkout_links`).first<{ reference: string; created_at: string }>())!;
  const wrong = await t.call("c_ps2", "check_payment_status", { checkout_reference: "ZZZZZZ", email: "pia@example.com" });
  assert.equal(wrong.json.verified, false);
  const wrongEmail = await t.call("c_ps2", "check_payment_status", { checkout_reference: ref.reference, email: "other@example.com" });
  assert.deepEqual(wrongEmail.json, wrong.json, "same answer for a wrong reference and a wrong email");
  const notStarted = await t.call("c_ps3", "check_payment_status", { checkout_reference: ref.reference.toLowerCase(), email: "PIA@example.com" });
  assert.equal(notStarted.json.payment_status, "not_started");
  // The customer signs up and Stripe's verified webhook marks the invoice paid (simulated by writing the state the webhook writes).
  const cust = await createCustomer(t.db, "pia@example.com");
  const orderId = newId("ord"), invId = newId("inv"), at = new Date(Date.parse(ref.created_at) + 60_000).toISOString();
  await t.db.batch([
    t.db.prepare(`INSERT INTO orders (id, organization_id, product_id, total_cents, status, kind, created_at) VALUES (?,?,?,?, 'pending_payment','package',?)`).bind(orderId, cust.organizationId, "starter", 99_900, at),
    t.db.prepare(`INSERT INTO invoices (id, organization_id, order_id, milestone_kind, amount_cents, status, description, created_at, stripe_checkout_session_id) VALUES (?,?,?, 'full', 99900, 'open', 'Starter package', ?, 'cs_test_fixture')`).bind(invId, cust.organizationId, orderId, at),
  ]);
  assert.equal((await t.call("c_ps3", "check_payment_status", { checkout_reference: ref.reference, email: "pia@example.com" })).json.payment_status, "checkout_started_not_paid");
  await t.db.prepare(`UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ?`).bind(at, invId).run();
  const paid = await t.call("c_ps3", "check_payment_status", { checkout_reference: ref.reference, email: "pia@example.com" });
  assert.equal(paid.json.payment_status, "paid", "read-only: a repeated question gets the current state, not a replay");
  assert.ok(!JSON.stringify(paid.json).includes("cs_test"), "no Stripe identifiers returned");
  // Lockout after three failed verifications on one call.
  for (let i = 0; i < 3; i++) await t.call("c_ps4", "check_payment_status", { checkout_reference: `BAD${i}XX`, email: "pia@example.com" });
  const locked = await t.call("c_ps4", "check_payment_status", { checkout_reference: ref.reference, email: "pia@example.com" });
  assert.equal(locked.json.locked, true);
  assert.equal((await t.call("c_ps5", "check_payment_status", { email: "pia@example.com" })).status, 422);
});

// ───────────── 6. schedule_consultation ─────────────

test("[VOICE-003] schedule_consultation: off switch, real slots, booking, idempotent retry and no double booking (fixture)", async () => {
  const t = await app();
  const off = await t.call("c_sc0", "schedule_consultation", {});
  assert.equal(off.json.step, "availability");
  assert.equal(off.json.available, false);
  assert.equal(off.json.reason, "scheduling_disabled", "never a fake confirmation when scheduling is off");
  await saveVoiceConfig(t.db, t.owner.id, configured(true));
  const slots = await t.call("c_sc1", "schedule_consultation", { preferred_date: "2026-11-03" });
  assert.equal(slots.json.available, true);
  const start = slots.json.slots[0].start_time;
  assert.equal(start, "2026-11-03T14:00:00.000Z");
  assert.equal((await t.call("c_sc1", "schedule_consultation", { start_time: start })).status, 422, "booking needs name, phone and topic");
  const args = { name: "Sam Sched", phone: "+15550100123", email: "sam@example.com", topic: "Redesign", start_time: start };
  const b = await t.call("c_sc1", "schedule_consultation", args);
  assert.equal(b.json.step, "booking");
  assert.equal(b.json.booked, true);
  assert.match(b.json.confirmation_code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.deepEqual((await t.call("c_sc1", "schedule_consultation", args)).json, b.json, "retry replays; no second booking");
  const clash = await t.call("c_sc2", "schedule_consultation", { ...args, name: "Other", phone: "+15550100124", email: undefined }, { from_number: "+15550100124" });
  assert.equal(clash.json.booked, false, "slot conflict refused");
  assert.ok(clash.json.slots.length > 0 && clash.json.slots.every((s: { start_time: string }) => s.start_time !== start), "alternatives exclude the taken slot");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM consultations WHERE starts_at = ? AND status IN ('requested','confirmed')`, start), 1);
  // Availability after booking no longer offers the taken slot (read-only answers are not replayed).
  const after = await t.call("c_sc1", "schedule_consultation", { preferred_date: "2026-11-03" });
  assert.notEqual(after.json.slots[0].start_time, start);
  // The call outcome counts the booking as a captured lead.
  await t.call("c_sc1", "schedule_consultation", { preferred_date: "bad-date" }).then((r) => assert.equal(r.status, 422));
});

// ───────────── 7. create_support_ticket ─────────────

test("[SUP-001] [SEC-002] create_support_ticket opens a real ticket only for a verified email+phone match; same answer shape otherwise (fixture)", async () => {
  const t = await app();
  const cust = await createCustomer(t.db, "help.me@example.com");
  await t.db.prepare(`INSERT INTO contacts (id, name, email, phone, user_id, created_at) VALUES (?,?,?,?,?,?)`).bind(newId("ct"), "Pat Customer", cust.email, "(555) 010-0150", cust.id, nowIso()).run();
  const ok = await t.call("c_st1", "create_support_ticket", { name: "Pat Customer", email: "help.me@example.com", phone: "+15550100150", summary: "Contact form stopped sending" });
  assert.equal(ok.status, 200);
  assert.match(ok.json.request_reference, /^SR-[A-HJ-NP-Z2-9]{6}$/);
  const ticket = (await t.db.prepare(`SELECT id, organization_id, voice_request_ref, status FROM tickets`).first<{ id: string; organization_id: string; voice_request_ref: string; status: string }>())!;
  assert.equal(ticket.voice_request_ref, ok.json.request_reference, "the spoken reference identifies the real ticket");
  assert.equal(ticket.organization_id, cust.organizationId);
  assert.equal(ticket.status, "open");
  assert.deepEqual((await t.call("c_st1", "create_support_ticket", { name: "Pat Customer", email: "help.me@example.com", phone: "+15550100150", summary: "Contact form stopped sending" })).json, ok.json, "retry: same ticket");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM tickets`), 1);
  const stranger = await t.call("c_st2", "create_support_ticket", { name: "Pat Customer", email: "help.me@example.com", phone: "+15550100777", summary: "Contact form stopped sending" });
  assert.deepEqual(Object.keys(stranger.json).sort(), Object.keys(ok.json).sort());
  assert.equal(stranger.json.message.replace(/S R - .*$/, ""), ok.json.message.replace(/S R - .*$/, ""), "identical wording: no account enumeration");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM tickets`), 1, "wrong phone: no ticket");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM crm_activities WHERE kind = 'task' AND body LIKE ?`, `Support callback ${stranger.json.request_reference}%`), 1, "a CRM callback task carries the reference instead");
  assert.equal((await t.call("c_st3", "create_support_ticket", { name: "Pat", email: "help.me@example.com", phone: "+15550100150" })).status, 422, "summary required");
});

// ───────────── 8. send_customer_email ─────────────

test("[EMAIL-001] [VOICE-003] send_customer_email sends only fixed templates, within per-call and per-recipient caps (fixture)", async () => {
  const t = await app();
  const r = await t.call("c_em1", "send_customer_email", { template: "package_information", name: "Em Mailer", email: "em@example.com" });
  assert.equal(r.status, 200);
  assert.equal(r.json.email_sent, true);
  const mail = (await t.db.prepare(`SELECT d.template, m.text_body FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE d.to_email = 'em@example.com'`).first<{ template: string; text_body: string }>())!;
  assert.equal(mail.template, "voice_followup");
  assert.match(mail.text_body, /Starter: \$999/);
  assert.deepEqual((await t.call("c_em1", "send_customer_email", { template: "package_information", name: "Em Mailer", email: "em@example.com" })).json, r.json, "retry: one email");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_deliveries WHERE to_email = 'em@example.com'`), 1);
  assert.equal((await t.call("c_em2", "send_customer_email", { template: "promo_offer", name: "Em Mailer", email: "em@example.com" })).status, 422, "no marketing or free-form template");
  assert.equal((await t.call("c_em2", "send_customer_email", { template: "package_information", name: "Em Mailer", email: "em@example.com", body: "Buy now!" })).json.email_sent, true, "extra fields such as a body are ignored, never sent");
  const sent = (await t.db.prepare(`SELECT m.text_body FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE d.to_email = 'em@example.com' ORDER BY d.rowid DESC`).first<{ text_body: string }>())!;
  assert.doesNotMatch(sent.text_body, /Buy now/);
  // consultation_details only for a booking made on this call.
  const other = await t.call("c_em3", "send_customer_email", { template: "consultation_details", name: "Em Mailer", email: "em3@example.com", confirmation_code: "ABCDEF" });
  assert.equal(other.json.reason, "not_found");
  // Per-call cap.
  for (let i = 0; i < MAX_EMAILS_PER_CALL; i++) await t.call("c_em4", "send_customer_email", { template: "package_information", name: "Em Mailer", email: `cap${i}@example.com` });
  const over = await t.call("c_em4", "send_customer_email", { template: "package_information", name: "Em Mailer", email: "cap9@example.com" });
  assert.equal(over.json.reason, "call_limit");
  // Per-recipient daily cap across calls (em@ already received 2 today).
  await t.call("c_em5", "send_customer_email", { template: "package_information", name: "Em Mailer", email: "em@example.com" });
  const limited = await t.call("c_em6", "send_customer_email", { template: "package_information", name: "Em Mailer", email: "em@example.com" });
  assert.equal(limited.json.reason, "recipient_limit");
});

test("[EMAIL-003] [VOICE-003] on staging, receptionist mail to an address outside the allowlist stays in the outbox (fixture)", async () => {
  const t = await createTestApp({ RETELL_INBOUND_API_KEY: KEY, ENVIRONMENT: "staging", RESEND_API_KEY: "re_fixture_inbound_0001", EMAIL_RECIPIENT_ALLOWLIST: "@crestmontwebsitedevelopment.com" } as Partial<Env>);
  let fetched = 0;
  t.env.overrides = { storage: t.storage, now: () => MON_9AM, fetch: (async () => { fetched++; return new Response("{}"); }) as unknown as typeof fetch };
  await t.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('voice.monthly_budget_usd', '50', ?)`).bind(nowIso()).run();
  const body = JSON.stringify({ name: "send_customer_email", call: { call_id: "c_stg1", call_type: "phone_call", from_number: "+15550100123" }, args: { template: "package_information", name: "Out Sider", email: "outsider@gmail.com" } });
  const res = await t.client().request("POST", URL_FN, { body, headers: { "x-retell-signature": await signRetell(KEY, body) } });
  assert.equal(res.status, 200);
  const row = (await t.db.prepare(`SELECT status, last_error FROM email_deliveries WHERE to_email = 'outsider@gmail.com'`).first<{ status: string; last_error: string | null }>())!;
  assert.notEqual(row.status, "sent");
  assert.ok(row.last_error, "the allowlist reason is recorded on the outbox row");
  assert.equal(fetched, 0, "Resend was never called");
});

// ───────────── Cross-cutting ─────────────

test("[VOICE-005] voicemail mode (no Owner voice budget) refuses all eight register functions (fixture)", async () => {
  const t = await app({ budget: false });
  const inbound = JSON.stringify({ event: "call_inbound", call_inbound: { call_id: "c_vm", from_number: "+15550100123", to_number: "+15550109999" } });
  await t.client().request("POST", "/api/webhooks/retell/inbound", { body: inbound, headers: { "x-retell-signature": await signRetell(KEY, inbound) } });
  for (const name of INBOUND_FUNCTIONS) {
    const r = await t.call("c_vm", name, { name: "Vee Mail", email: "vm@example.com", phone: "+15550100123", interest: "business", requirements: "Needs a website", summary: "Help please", package: "starter", template: "package_information", checkout_reference: "ABCDEF" });
    assert.equal(r.json.refused, "voicemail_mode", name);
  }
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM email_deliveries`), 0);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM tickets`), 0);
});

test("[VOICE-003] a call stamped for another environment is refused before any register function runs (fixture)", async () => {
  const t = await app();
  const r = await t.call("c_env", "crm_upsert_lead", { name: "Env Test", phone: "+15550100160", interest: "starter", requirements: "Wants a site" }, { metadata: { crestmont_env: "production" } });
  assert.equal(r.status, 409);
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM leads`), 0);
});

// ───────────── Master prompt and deploy wiring ─────────────

test("[VOICE-004] the inbound master instructions pass the platform's own prompt checks and name only real functions", async () => {
  const { INBOUND_MASTER_INSTRUCTIONS, defaultAgentPrompt, configProblems, composePrompt, VOICE_GUARDRAILS, VOICE_FUNCTIONS } = await import("../src/services/voice.ts");
  const { RETELL_ONLY_FUNCTIONS } = await import("../src/adapters/retell.ts");
  assert.equal(defaultAgentPrompt(), INBOUND_MASTER_INSTRUCTIONS, "/staff/voice pre-fills the master instructions");
  assert.deepEqual(configProblems(INBOUND_MASTER_INSTRUCTIONS), [], "no invented prices, no guardrail contradictions, ≤ 8,000 characters");
  assert.ok(composePrompt(INBOUND_MASTER_INSTRUCTIONS).startsWith(VOICE_GUARDRAILS), "activatable: guardrails come first");
  assert.doesNotMatch(INBOUND_MASTER_INSTRUCTIONS, /\$\s?\d/, "prices come only from get_packages_pricing");
  for (const n of INBOUND_FUNCTIONS) assert.match(INBOUND_MASTER_INSTRUCTIONS, new RegExp(`\\b${n}\\b`), `${n} is used by the prompt`);
  const known = new Set<string>([...VOICE_FUNCTIONS, ...RETELL_ONLY_FUNCTIONS]);
  const fields = new Set(["receptionist_mode", "link_sent", "scheduling_available", "start_time", "preferred_date", "reminder_call_ok", "confirmation_code",
    "already_booked", "next_step", "transfer_available", "package_information", "consultation_details", "business_hours"]);
  const unknown = [...INBOUND_MASTER_INSTRUCTIONS.matchAll(/\b([a-z]+(?:_[a-z]+)+)\b/g)].map((m) => m[1]).filter((n) => !known.has(n) && !fields.has(n));
  assert.deepEqual([...new Set(unknown)], [], "every snake_case name is a deployed function, a documented response field or a dynamic variable");
  assert.match(VOICE_GUARDRAILS, /create_support_ticket/);
  assert.match(VOICE_GUARDRAILS, /get_packages_pricing/);
});

test("[INFRA-005] [SEC-007] the staging deploy puts each Retell workspace key only when its staging environment secret is provided, change-aware", async () => {
  const { readFileSync } = await import("node:fs");
  const wf = readFileSync(".github/workflows/deploy-staging.yml", "utf8");
  const i = wf.indexOf("- name: Retell workspace keys (only those the Founder has provided)");
  assert.ok(i > 0);
  const step = wf.slice(i, wf.indexOf("- name:", i + 10));
  for (const [v, name] of [["RETELL_INBOUND_KEY", "RETELL_INBOUND_API_KEY"], ["RETELL_OUTBOUND_KEY", "RETELL_OUTBOUND_API_KEY"]]) {
    assert.match(step, new RegExp(`${v}: \\$\\{\\{ secrets\\.${name} \\}\\}`));
    assert.match(step, new RegExp(`if \\[ -n "\\$${v}" \\]; then printf '%s' "\\$${v}" \\| node --no-warnings scripts/staging-secrets\\.ts put ${name}`));
    assert.doesNotMatch(step, new RegExp(`echo[^\\n]*\\$${v}`), "never echoes a key");
  }
  assert.doesNotMatch(step, /RETELL_API_KEY\b/, "the legacy single key is not deployed");
  assert.ok(wf.indexOf("Deploy Worker (staging") < i, "after the Worker exists");
});

test("[VOICE-006] declining recording: only what the platform enforces is said, and nothing is kept (fixture)", async () => {
  const t = await app();
  const { CONSENT_DECLINED_MESSAGE } = await import("../src/adapters/retell.ts");
  const no = await t.call("c_cons_no", "record_consent", { consent: false });
  assert.equal(no.status, 200);
  assert.equal(no.json.message, CONSENT_DECLINED_MESSAGE);
  assert.doesNotMatch(no.json.message, /will not be recorded|isn't being recorded|not recording/i, "never claims Retell stopped recording");
  const ended = JSON.stringify({ event: "call_ended", call: { call_id: "c_cons_no", call_type: "phone_call", from_number: "+15550100123", call_status: "ended", transcript: "Agent: hello. User: my secret plans", recording_url: "https://example.com/rec.wav" } });
  await t.client().request("POST", "/api/webhooks/retell", { body: ended, headers: { "x-retell-signature": await signRetell(KEY, ended) } });
  const row = (await t.db.prepare(`SELECT transcript, recording_url, recording_consent FROM calls WHERE provider_call_id = 'c_cons_no'`).first<{ transcript: string | null; recording_url: string | null; recording_consent: number }>())!;
  assert.equal(row.recording_consent, 0);
  assert.equal(row.transcript, null, "transcript discarded without consent");
  assert.equal(row.recording_url, null, "recording link discarded without consent");
  const yes = await t.call("c_cons_yes", "record_consent", { consent: true });
  assert.match(yes.json.message, /may be recorded and transcribed/);
  const { INBOUND_MASTER_INSTRUCTIONS } = await import("../src/services/voice.ts");
  assert.match(INBOUND_MASTER_INSTRUCTIONS, /never that the call has stopped being recorded/);
});

test("[VOICE-005] the voice budget is enforced on functions even when the number's inbound webhook never ran (fixture)", async () => {
  const t = await app({ budget: false });
  // No /api/webhooks/retell/inbound call for this call id: the number has no inbound webhook configured.
  const r = await t.call("c_nowh", "crm_upsert_lead", { name: "No Webhook", phone: "+15550100180", interest: "starter", requirements: "Wants a website" });
  assert.equal(r.json.refused, "voicemail_mode", "no budget → message-only, whatever the webhook setup");
  assert.equal(await count(t.db, `SELECT COUNT(*) n FROM leads`), 0);
  assert.equal((await t.call("c_nowh", "request_callback", { name: "No Webhook", phone: "+15550100180", reason: "Call me back" })).json.callbackRequested, true, "a message can always be left");
  await t.db.prepare(`INSERT INTO business_settings (key, value, updated_at) VALUES ('voice.monthly_budget_usd', '50', ?)`).bind(nowIso()).run();
  assert.equal((await t.call("c_nowh2", "crm_upsert_lead", { name: "No Webhook", phone: "+15550100181", interest: "starter", requirements: "Wants a website" })).json.lead_saved, true, "with a budget the full receptionist works");
});
