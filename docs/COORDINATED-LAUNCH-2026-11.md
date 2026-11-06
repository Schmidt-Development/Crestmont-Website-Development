# Coordinated launch — sales agents, calendars, intake and payments (Founder directive 2026-11-06)

What the final master prompt asked for, what the code now does, and what still needs the Founder, a provider or
counsel. Nothing here deploys anything. Production deploys only through `deploy-production.yml`, after a NEW
release candidate for the final scope is approved (the `v1.0.0` candidate covered the earlier, restricted scope and
its deploy run was cancelled).

## What the platform now does (code, covered by `npm test`)

| Area | Behaviour | Where |
|---|---|---|
| Calling modes | Two Owner switches on `/staff/sales-outbound`: **Scheduled AI Callbacks** (launch ON) and **AI Cold Outreach** (launch OFF). Either works without the other. | `src/services/sales-outbound.ts`, `src/routes/sales-outbound.ts` |
| Concurrency | Cold ≤ 15, 5 slots reserved for callbacks (never borrowed by cold, even idle), atomic reservations, released on end/failure/retry/stale. Shared inbound capacity shrinks outbound. | `src/domain/outbound-capacity.ts`, migration 0090 |
| Ramp | Launch 0 → Pilot 10 → 25 → 50 → 100 → 200 cold calls/day, editable; each increase needs the Founder's ticked authorisation; audited. | same |
| Callbacks | Booking on the AI Outbound Calendar queues one callback at that time with the earlier context; reschedule moves it, cancel cancels it; >30 min late = missed, given to a person, never dialled late. | `src/services/appointment-callbacks.ts` |
| AI Outbound Calendar | 30-minute appointments, up to 5 per slot (database trigger, race-safe), own hours (default every day 09:00–20:00 business time), confirmed when booked. | `src/services/voice-scheduling.ts` |
| Founder Calendar | Separate; one appointment per slot; Founder windows; held until the Founder confirms; offered only on an explicit request (`wants_founder`). | same, `src/domain/calendars.ts` |
| Receptionist | Sells 24/7; no "closed"/message-taking fallback; only live transfer follows staffed hours; never suggests the Founder. | `src/services/voice.ts` |
| Intake before payment | Package → intake → review (scope, price, agreements) → Stripe → project with the intake already attached. One shared rule (`requireIntakeForPayment`) covers new checkout, legacy unpaid orders, quote deposits, Stripe-hosted quote invoices (refused before issue) and the staff payment simulation. Hosted invoices issued before the rule are listed for manual remediation on `/staff/finance/invoices`. | `src/services/purchase-intake.ts` |
| Self-Improvement Engine | Dashboard: current/previous version, per-version calls and rates (qualified, appointment conversion, sales, revenue), proposals, approval log, rollback history. | `src/routes/sales-optimization.ts` |

## Founder / provider actions (cannot be done from code)

1. **Retell — sales agent callback script.** The sales agent's spoken prompt is SIE-managed (version 1 =
   `docs/voice/outbound-sales-agent-prompt.txt`), so it is changed through the engine, never by hand. Create a new
   version on `/staff/sales-optimization` adding the paragraph below, evaluate, approve, deploy to staging, verify the
   read-back, then production:

   > CALL MODE. If {{call_mode}} is "scheduled_callback", this is a call the prospect booked: say you are calling
   > back as arranged for {{callback_appointment}}, recap {{callback_reason}} and {{previous_conversation_summary}}
   > in one sentence, and continue from there without asking for details they already gave. Otherwise this is a
   > first outreach call.

   Until then callbacks dial with the variables set but the agent does not refer to them.
2. **Retell — receptionist.** Activate the updated receptionist instructions on `/staff/voice` (prompt sync writes
   `general_prompt` and verifies the read-back). If the live V4 prompt was edited in the Retell dashboard, the drift
   guard refuses the overwrite: remove any after-hours / "we're closed" branching there first, then adopt or
   activate. Add the optional `wants_founder` (boolean) parameter to the `check_consultation_availability` tool.
3. **Retell — concurrency.** Run the outbound Retell audit (it calls `GET /get-concurrency`) and record the real
   limit and whether inbound shares it on `/staff/sales-outbound`. The 15 + 5 allocation is the maximum; more
   concurrency is a purchase the Founder must approve.
4. **Production secrets for callbacks:** the production Worker needs `RETELL_OUTBOUND_API_KEY` (sales workspace),
   the sales agent id and an approved caller number saved on `/staff/sales-outbound`. The readiness phased-release
   deferral for "AI Receptionist" / "AI Sales Optimization" must be reinstated (in scope) for the deploy to accept
   those keys; `RETELL_SALES_OUTBOUND` stays `off` until cold outreach is authorised.
5. **Cold outreach (stays OFF):** AI-voice telemarketing needs prior express written consent (FCC 24-17, 47 CFR
   64.1200), a National DNC scrub and state rules. A public business number or an Approved-CRM record is not
   consent. It opens only after counsel approves the consent design (recorded on `/staff/sales-outbound`), consent
   records exist per number, the Founder switches it on and authorises a ramp stage. Counsel should also confirm
   the callback consent model (a recorded request on the call) and both calling windows.
6. **Founder Google Calendar** (code: `src/services/founder-calendar.ts`, `src/adapters/google-calendar.ts`, migration
   0092). The internal Founder Calendar stays the booking record; Google adds real availability (free/busy of the
   primary + dedicated calendar — times only) and shows every appointment on "Crestmont — Founder Appointments"
   (created by the platform, or reused if it already exists). The Founder is emailed (platform mailer) for every new,
   moved, confirmed and cancelled appointment, once each. If Google cannot be read, no Founder time is offered.
   Founder steps, once per environment (staging first, then production):
   1. Google Cloud Console (free) → create an OAuth client of type *Web application*; authorised redirect URIs
      `https://crestmont-platform-staging.partners-df4.workers.dev/oauth/google/founder-calendar/callback` and
      `https://crestmontwebsitedevelopment.com/oauth/google/founder-calendar/callback`. Enable the Google Calendar API.
      While the OAuth consent screen is in "Testing", add your Google account as a test user.
   2. Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` on the Worker (staging and production secrets).
   3. Sign in as the Owner → `/staff/calendars/founder-callback/google` → enter your Google account → *Connect with
      Google* → allow the requested permissions. The page then shows the live check (calendar + free/busy).
   4. Set your Founder appointment windows on `/staff/voice/operations`, then ask the receptionist (test call) for the
      Founder and confirm the event and email arrive.
7. **Live Stripe payments** — production checkout is closed by `commerceBlock` until ALL hold:
   - the legal policies are attorney-reviewed and published (today `DRAFT_BANNER` is set in `src/content/legal.ts`);
   - Business settings `business.legal_name` = "Talent Revenue Systems LLC" on production;
   - production Worker: `STRIPE_SECRET_KEY` (live), `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`,
     `PAYMENTS_LIVE_AUTHORIZED` = `yes`;
   - one live webhook endpoint `https://crestmontwebsitedevelopment.com/api/webhooks/stripe` with
     `checkout.session.completed`, `checkout.session.expired`, `invoice.paid`, `charge.refunded`,
     `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`.
   None of these can be verified from the repository; no real-money transaction is run. After the first production
   deploy, `GET /api/health` reports `payments.mode`, `payments.checkout` (open/closed) and the exact reason checkout
   is closed, plus whether the webhook secret is present — from the running Worker, with no secret shown. No
   publishable key is needed: checkout is Stripe-hosted.
   - `business.legal_name` is set on production by the Owner in Business settings after the first deploy (a migration
     cannot set it: it changes the rendered agreement texts, which are versioned).
8. **AI Website Builder:** separate session. `decideEligibility` queues a build once payment and intake exist; it does
   not check staff scope APPROVAL. The directive requires authorised scope — for the Builder session to decide.
9. **Release:** after the Builder passes its gates, create a new release candidate for the final `main` commit
   (`release.yml`, manual dispatch with a new tag), Founder approval, GitHub `production` approval.
