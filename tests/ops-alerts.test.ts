// Owner alerting (CREST-GAP-015, -089, -024 alert part): the scheduled ops_alerts job emails the Owners once per
// item/window. All rows here are TEST DATA inserted directly; no provider is called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff } from "./support/app.ts";
import { runJobs, SCHEDULE } from "../src/app/scheduled.ts";
import { collectAlertItems, runOpsAlerts, ALERT_THRESHOLDS } from "../src/services/monitoring.ts";
import { OutboxEmail } from "../src/adapters/email.ts";
import { MIN_BACKLOG_FOR_TARGET, TARGET_PER_MINUTE } from "../src/services/research-promote.ts";

const NOW = new Date("2026-10-29T10:30:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60e3).toISOString();

async function setup() {
  const app = await createTestApp({ overrides: { now: () => NOW } });
  const owner = await createStaff(app.db, "owner", "founder@crestmont.test", "Olivia Owner");
  await createStaff(app.db, "administrator", "admin@crestmont.test", "Adam Admin");
  const ctx = { db: app.db, email: new OutboxEmail(app.db), baseUrl: "https://crestmont.example", now: () => NOW };
  return { ...app, owner, ctx };
}
const alertMails = async (db: Awaited<ReturnType<typeof setup>>["db"]) =>
  (await db.prepare(`SELECT d.to_email, m.subject, m.text_body FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE d.template = 'critical_incident' ORDER BY d.rowid`).all<{ to_email: string; subject: string; text_body: string }>()).results;

test("[INFRA-006] ops_alerts emails the internal operations mailbox for dead-lettered Stripe events, new reconciliation findings, a stuck email queue and failing feeds — once per item", async () => {
  const t = await setup();
  const db = t.db;
  await db.prepare(`INSERT INTO stripe_events (id, type, stripe_created, payload, status, attempts, received_at) VALUES ('evt_dead_1', 'invoice.paid', 1, '{}', 'dead_letter', 5, ?)`).bind(ago(30)).run();
  await db.prepare(`INSERT INTO stripe_events (id, type, stripe_created, payload, status, attempts, received_at) VALUES ('evt_ok_1', 'invoice.paid', 1, '{}', 'processed', 1, ?)`).bind(ago(30)).run();
  await db.prepare(`INSERT INTO reconciliation_findings (id, fingerprint, kind, scope, stripe_object_id, detail, status, first_seen_at, last_seen_at) VALUES ('rcf_1', 'fp1', 'amount_mismatch', 'checkout', 'in_123', 'Amount differs', 'open', ?, ?)`).bind(ago(20), ago(20)).run();
  await db.prepare(`INSERT INTO reconciliation_findings (id, fingerprint, kind, scope, detail, status, first_seen_at, last_seen_at) VALUES ('rcf_done', 'fp2', 'amount_mismatch', 'checkout', 'Old', 'resolved', ?, ?)`).bind(ago(2000), ago(2000)).run();
  await db.prepare(`INSERT INTO email_deliveries (id, template, to_email, idempotency_key, status, created_at, updated_at) VALUES ('ed_1', 'receipt', 'x@example.com', 'k1', 'queued', ?, ?)`).bind(ago(120), ago(120)).run();
  await db.prepare(`INSERT INTO email_messages (delivery_id, provider, subject, html_body, text_body) VALUES ('ed_1', 'resend', 's', 'h', 't')`).run();
  await db.prepare(`INSERT INTO ingestion_status (source, last_success_at, last_attempt_at, last_error) VALUES ('ci', ?, ?, 'signature mismatch')`).bind(ago(600), ago(10)).run();
  await db.prepare(`INSERT INTO ingestion_status (source, last_success_at, last_attempt_at, last_error) VALUES ('job:retention', ?, ?, 'old error')`).bind(ago(5), ago(5)).run();
  await db.prepare(`INSERT INTO ingestion_status (source, last_success_at, last_attempt_at, last_error) VALUES ('file-storage:staging', NULL, ?, 'R2 not enabled')`).bind(ago(5)).run();

  const items = await collectAlertItems(db, NOW);
  assert.deepEqual(items.map((i) => i.key).sort(), [
    `email_queue_stuck:${ago(120)}`, `feed_failing:ci:${ago(600)}`, "reconciliation_finding:rcf_1", "stripe_dead_letter:evt_dead_1",
  ].sort(), "only real, current conditions; recovered feeds and optional storage are not alerts");

  const r1 = await runOpsAlerts(t.ctx);
  assert.equal(r1.raised, 4);
  assert.equal(r1.recipients, 1, "one recipient: the internal operations mailbox (no staff member is mailed personally)");
  const mails = await alertMails(db);
  assert.equal(mails.length, 4, "one email per category");
  assert.ok(mails.every((m) => m.to_email === "crestmontwebsitedevelopment@gmail.com"));
  assert.ok(mails.some((m) => /dead-letter/.test(m.subject) && /evt_dead_1/.test(m.text_body)));
  assert.ok(mails.some((m) => /reconciliation/i.test(m.subject) && /rcf_1/.test(m.text_body)));
  assert.ok(mails.some((m) => /stuck/.test(m.subject)));
  assert.ok(mails.some((m) => /feeds are failing/.test(m.subject) && /signature mismatch/.test(m.text_body)));
  assert.ok(mails.every((m) => m.text_body.includes("https://crestmont.example/staff/")), "links back into staff pages");

  // Deduplicated: the next runs (every 15 minutes) send nothing new for the same items.
  const r2 = await runOpsAlerts(t.ctx);
  assert.equal(r2.raised, 0);
  assert.equal((await alertMails(db)).length, 4);
  // A NEW dead letter is alerted on its own.
  await db.prepare(`INSERT INTO stripe_events (id, type, stripe_created, payload, status, attempts, received_at) VALUES ('evt_dead_2', 'charge.refunded', 1, '{}', 'dead_letter', 5, ?)`).bind(ago(1)).run();
  const r3 = await runOpsAlerts(t.ctx);
  assert.equal(r3.raised, 1);
  const last = (await alertMails(db)).at(-1)!;
  assert.match(last.text_body, /evt_dead_2/);
  assert.doesNotMatch(last.text_body, /evt_dead_1/, "already-alerted items are not repeated");
  // A feed that recovers and fails again is a new episode.
  await db.prepare(`UPDATE ingestion_status SET last_success_at = ?, last_attempt_at = ?, last_error = 'again' WHERE source = 'ci'`).bind(ago(4), ago(3)).run();
  assert.equal((await runOpsAlerts(t.ctx)).raised, 1);
  // Nothing in ops_alerts stores an email address.
  assert.doesNotMatch(JSON.stringify((await db.prepare(`SELECT * FROM ops_alerts`).all()).results), /@/);
});

test("[INFRA-006] [SEC-004] security alerting: an MFA-failure burst, account lockouts, sign-in challenges and every recovery-code use alert the Owners (CREST-GAP-089, -024)", async () => {
  const t = await setup();
  const db = t.db;
  const ev = (kind: string, min: number, user: string | null, email: string | null = null, ip: string | null = null) =>
    db.prepare(`INSERT INTO security_events (kind, user_id, email, ip, detail, created_at) VALUES (?,?,?,?,NULL,?)`).bind(kind, user, email, ip, ago(min)).run();
  // 7 wrong codes: below the threshold; the 8th crosses it.
  for (let i = 0; i < ALERT_THRESHOLDS.mfa_failed - 1; i++) await ev("mfa_failed", 5 + i, t.owner.id);
  await ev("mfa_failed", 90, t.owner.id); // outside the 1-hour window
  assert.equal((await collectAlertItems(db, NOW)).length, 0, "7 failures in the hour do not alert");
  await ev("mfa_failed", 1, t.owner.id);
  await ev("mfa_recovery_code_used", 2, t.owner.id);
  for (let i = 0; i < 3; i++) await ev("login_challenge_started", 3 + i, null, "victim@example.com", "203.0.113.9");
  await ev("login_locked", 4, "usr_someone");
  const r = await runOpsAlerts(t.ctx);
  assert.equal(r.raised, 4);
  const mails = await alertMails(db);
  assert.equal(mails.length, 1, "one email for the security category");
  assert.match(mails[0].subject, /Repeated security events/);
  assert.match(mails[0].text_body, new RegExp(`8 wrong two-factor codes in the last hour for account ${t.owner.id}`));
  assert.match(mails[0].text_body, /recovery code was used/);
  assert.match(mails[0].text_body, /3 sign-in challenges/);
  assert.match(mails[0].text_body, /account lockouts/);
  assert.doesNotMatch(JSON.stringify((await db.prepare(`SELECT * FROM ops_alerts`).all()).results), /victim@example\.com|203\.0\.113\.9/, "addresses and IPs are hashed");
  // Same hour: more failures do not alert again; the next hour's burst does.
  await ev("mfa_failed", 0, t.owner.id);
  assert.equal((await runOpsAlerts(t.ctx)).raised, 0);
  const later = new Date(NOW.getTime() + 3600e3);
  for (let i = 0; i < ALERT_THRESHOLDS.mfa_failed; i++) await db.prepare(`INSERT INTO security_events (kind, user_id, created_at) VALUES ('mfa_failed', ?, ?)`).bind(t.owner.id, new Date(later.getTime() - (i + 1) * 60e3).toISOString()).run();
  assert.equal((await runOpsAlerts({ ...t.ctx, now: () => later })).raised, 1);
});

test("[INFRA-006] [READY-012] ops_alerts runs every 15 minutes as a recorded scheduled job and never fails a run without Owners or rows", async () => {
  assert.ok(SCHEDULE["*/15 * * * *"].includes("ops_alerts"));
  assert.equal(SCHEDULE["*/15 * * * *"].at(-1), "ops_alerts", "runs after the jobs whose results it reports");
  const { db, env } = await createTestApp();
  const res = await runJobs(env, ["ops_alerts"]);
  assert.equal(res.ops_alerts.ok, true, res.ops_alerts.detail);
  assert.match(res.ops_alerts.detail, /0 new of 0 alert items; 0 emails to 0 owner/);
  assert.ok(await db.prepare(`SELECT 1 FROM ingestion_status WHERE source = 'job:ops_alerts' AND last_error IS NULL`).first());
});

// ───────────── CRM promotion throughput ─────────────

test("[INFRA-006] promotion alerting: below target with a backlog alerts; a drained backlog and a switched-off promoter never do", async () => {
  const t = await setup();
  const db = t.db;
  const of = async (cat: string) => (await collectAlertItems(db, NOW)).filter((i) => i.category === cat);

  // Automatic promotion off: its rate is not a fault, it is a decision.
  assert.equal((await of("promotion_below_target")).length, 0, "nothing to say while the Owner has it switched off");

  await db.prepare(`UPDATE research_settings SET auto_promote = 1 WHERE id = 1`).run();
  // On, but nothing eligible: a drained backlog is the GOAL. A low rate here must never raise anything, or the alert
  // would fire forever the moment the system succeeded.
  assert.equal((await of("promotion_below_target")).length, 0, "a drained backlog is success, not a stall");

  // A real backlog and no imports: this is the condition worth waking someone for.
  const stmts = [];
  for (let i = 0; i < MIN_BACKLOG_FOR_TARGET + 5; i++) {
    stmts.push(db.prepare(`INSERT INTO research_prospects (id, business_key, name, name_norm, sources_json, website_class, website_json, findings_json, findings_count,
        identity_confidence, score, qualified, qualification_json, status, shared_phone, eligibility, eligibility_json, content_hash, last_verified_at, first_seen_at, updated_at)
      VALUES (?,?,?,?,'[]','NO_OFFICIAL_WEBSITE_FOUND','{}','[]',0,0.9,80,1,'[]','qualified',0,'blocked','[]',?,?,?,?)`)
      .bind(`rp_alert_${i}`, `overture:alert${i}`, `Alert Co ${i}`, `alert co ${i}`, `h${i}`, ago(30), ago(30), ago(30)));
  }
  await db.batch(stmts);
  const low = await of("promotion_below_target");
  assert.equal(low.length, 1, "below target with work waiting is an alert");
  assert.match(low[0].summary, /created 0 new leads in the last 15 minutes \(0.0\/minute against a target of 25\)/);
  assert.match(low[0].summary, /eligible prospects are waiting/);
  // Keyed by the hour, so a sustained shortfall is stated once an hour rather than once a minute.
  assert.equal(low[0].key, `promotion_below_target:${NOW.toISOString().slice(0, 13)}`);

  // Hitting the target silences it — and the rate is read from the leads table, not from any job counter, which is
  // why these rows alone are enough to clear it without a single promotion run being recorded.
  await db.prepare(`INSERT INTO contacts (id, name, created_at) VALUES ('ct_rate','Rate Co',?)`).bind(ago(60)).run();
  const leads = [];
  for (let i = 0; i < TARGET_PER_MINUTE * ALERT_THRESHOLDS.promotion_rate_window_minutes; i++) {
    leads.push(db.prepare(`INSERT INTO leads (id, contact_id, source, origin, stage, created_at, updated_at) VALUES (?, 'ct_rate','manual','research_agent','new',?,?)`)
      .bind(`ld_rate_${i}`, ago(5), ago(5)));
  }
  await db.batch(leads);
  assert.equal((await of("promotion_below_target")).length, 0, "at target, nothing is raised");
});

// ───────────── Lead research worker (docs/research/PRODUCTION.md §6 alerting gap) ─────────────

test("[INFRA-006] research alerting: resumed research with no worker checking in alerts the Owners; a paused agent never does", async () => {
  const t = await setup();
  const db = t.db;

  // Research ships PAUSED. That is its intended resting state, so it is never an alert, even with no worker at all.
  assert.equal((await db.prepare(`SELECT paused FROM research_settings WHERE id = 1`).first<{ paused: number }>())?.paused, 1);
  assert.equal((await collectAlertItems(db, NOW)).filter((i) => i.category === "research_worker_stale").length, 0,
    "a paused research agent is not a fault: the dashboard already shows it");

  // Resumed, but nothing has ever reported in: exactly the case that looks like it is running and is not.
  await db.prepare(`UPDATE research_settings SET paused = 0, pause_reason = NULL, updated_at = ? WHERE id = 1`).bind(ago(60)).run();
  const never = (await collectAlertItems(db, NOW)).filter((i) => i.category === "research_worker_stale");
  assert.equal(never.length, 1);
  assert.equal(never[0].key, `research_worker_stale:never:${NOW.toISOString().slice(0, 10)}`);
  assert.match(never[0].summary, /no research worker has ever checked in/);
  assert.match(never[0].summary, /No businesses are being evaluated/);

  // A worker that checked in recently is healthy: no alert.
  const beat = async (id: string, at: string, status: Record<string, unknown> = {}) =>
    db.prepare(`INSERT INTO research_runners (runner_id, version, first_seen_at, last_seen_at, status_json) VALUES (?,?,?,?,?)
      ON CONFLICT(runner_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, status_json = excluded.status_json`)
      .bind(id, "0.1.0", ago(600), at, JSON.stringify(status)).run();
  await beat("workstation-1", ago(2));
  assert.equal((await collectAlertItems(db, NOW)).filter((i) => i.category === "research_worker_stale").length, 0, "a worker heard from 2 minutes ago is fine");

  // Gone quiet past the threshold: one alert per stall episode, keyed by the last heartbeat.
  await beat("workstation-1", ago(ALERT_THRESHOLDS.research_heartbeat_stale_minutes + 5));
  const stale = (await collectAlertItems(db, NOW)).filter((i) => i.category === "research_worker_stale");
  assert.equal(stale.length, 1);
  assert.equal(stale[0].key, `research_worker_stale:${ago(ALERT_THRESHOLDS.research_heartbeat_stale_minutes + 5)}`);
  assert.match(stale[0].summary, /no research worker has checked in for 35 minutes/);

  // Owners are emailed once for the episode, and the alert points at the research dashboard.
  const first = await runOpsAlerts(t.ctx);
  assert.ok(first.categories.includes("research_worker_stale"));
  const mail = (await alertMails(db)).find((m) => /research/i.test(m.text_body));
  assert.ok(mail, "an Owner was emailed about the research worker");
  assert.match(mail!.text_body, /\/staff\/research/);
  const second = await runOpsAlerts(t.ctx);
  assert.equal(second.raised, 0, "the same stall is not emailed twice");
});

test("[INFRA-006] research alerting: a worker whose credentials the platform refuses is reported, because it has stopped delivering", async () => {
  const t = await setup();
  const db = t.db;
  await db.prepare(`UPDATE research_settings SET paused = 0, pause_reason = NULL, updated_at = ? WHERE id = 1`).bind(ago(60)).run();
  await db.prepare(`INSERT INTO research_runners (runner_id, version, first_seen_at, last_seen_at, status_json) VALUES ('workstation-1','0.1.0',?,?,?)`)
    .bind(ago(600), ago(1), JSON.stringify({ platform: { ok: false, authFailed: true, lastError: "401" } })).run();
  const items = (await collectAlertItems(db, NOW)).filter((i) => i.category === "research_worker_stale");
  assert.equal(items.length, 1);
  assert.match(items[0].summary, /credentials are being refused/);
  assert.match(items[0].summary, /RESEARCH_RUNNER_SECRET/);
  assert.equal(items[0].subject, "workstation-1");

  // Unreadable worker-reported JSON must not break the job (it is the worker's own text, not ours).
  await db.prepare(`UPDATE research_runners SET status_json = 'not json' WHERE runner_id = 'workstation-1'`).run();
  assert.equal((await collectAlertItems(db, NOW)).filter((i) => i.category === "research_worker_stale").length, 0);
});
