# AI Sales Optimization engine — architecture, audit and operations

**Status (2026-10-30): built and tested against fixtures. Not activated and not live.** No Retell sales agent exists, no
real call or payment has gone through the engine, and the self-hosted runner has not run any of its jobs. Requirements
SALESOPT-001…012 are all `in_progress` (see `requirements/status/sales-opt.ts`).

> **Scope boundary.** The engine *evaluates and improves* the prompt of a registered Retell **sales** agent. It never places
> calls. This platform has no sales-calling path. Outbound calling is limited to three consented purposes
> (`callback`, `consultation_reminder`, `support_followup`; `src/services/voice-outbound.ts`). That follows Founder
> decision **D-14**: outbound sales calling needs a new consent design and counsel's TCPA review first. See also
> MSA Sched. C.7 and `docs/legal/RESEARCH-NOTES-2026-10.md` rows 4–7. The brief's target of 5,500 dialling attempts
> a day is out of scope here. Enabling it is a separate, Founder-approved change after counsel's review.

## 1. Phase 0 audit (verified facts, 2026-10-30)

| Area | Finding | Source |
|---|---|---|
| Repository | Cloudflare Worker + D1, Node ≥ 22.18, no runtime dependencies. 608 tests passing on `main` at `523764d`. | `README.md`, `npm test` |
| Retell agents | **None exist.** The receptionist is specified, not created; provider approval is still open (BLK-009). | `docs/voice/RETELL-AGENT-SPEC.md`, `seeds/blockers.sql` |
| Agent architecture | The platform supports only a **Retell LLM** response engine (`response_engine.type = "retell-llm"`). Prompt sync refuses other engines. | `src/services/voice-prompt-sync.ts` |
| Inbound/outbound separation | The spec recommends **one** agent for both directions. The engine therefore requires its own sales agent ids and refuses the receptionist's ids. | `RETELL-AGENT-SPEC.md` §1, `registry.ts#setTarget` |
| Webhooks | `X-Retell-Signature` HMAC (key = webhook-badged API key, ±5 min) verified fail-closed; events are idempotent per call. | `src/adapters/retell.ts`, `src/routes/hooks.ts` |
| Call data | `calls` holds outcome, duration, disconnection reason, cost, and transcript/recording/summary **only with consent**. Retention: `retention.voice_transcripts_days`. | `migrations/0009`, `0042`, `src/services/retention.ts` |
| CRM | `leads` (stages new → converted/lost), `orders.lead_id`, CRM activities. | `migrations/0001`, `0004` |
| Stripe | Signature-verified, idempotent, out-of-order-safe events. `payments` are written by `markInvoicePaid` with UNIQUE payment intent. Refunds and disputes update `payments.status`. | `src/domain/stripe-webhook.ts`, `src/services/payments.ts`, `commerce.ts` |
| Local AI | Self-hosted Ollama/Qwen on the Founder's Windows machine is reached only through the **build runner**, which pulls `ai_jobs` (provider `local-runner`) over a signed channel. The Worker never calls the model directly. | `src/services/ai-runner.ts`, `runner/src/drafts.ts`, `docs/ai-builds/WINDOWS-SUPERCOMPUTER.md` |
| Compliance controls | Do-not-call list, per-purpose consent, calling windows, per-number caps, staff approval and a voice budget, all re-checked before each dial. | `src/services/voice-outbound.ts`, `voice-budget.ts` |
| Credentials missing | `RETELL_API_KEY` (staging/production), a staging and a production **sales** agent in Retell, the runner with AI drafts enabled (`BUILD_RUNNER_SECRET`, `LOCAL_MODEL`), Stripe test keys on staging. None should be pasted into chat. Set them as Worker secrets / runner env. | — |

Retell API behaviour relied on, checked against docs.retellai.com on 2026-10-30:
- `PATCH /update-retell-llm/{llm_id}` updates an existing Retell LLM response engine. The response carries `version` and `is_published`.
- Versioning: published versions cannot be changed, and phone numbers or environment tags can pin a version. Edits change the draft. This engine therefore never publishes. Publishing in the dashboard and pointing the number at the new version are manual Founder steps. A `publish-agent-version` endpoint appears in third-party references, but a Retell community answer says publishing is dashboard-only. It was **not** verified, so it is not used.
- Calls that never connect (`dial_failed`, `dial_no_answer`, `dial_busy`) send no `call_started` but still send `call_ended` and `call_analyzed`.

## 2. Architecture

```
Retell (sales agent) ──signed webhook──▶ /api/webhooks/retell ──▶ voice handler (unchanged: calls row, consent, CRM)
                                                        └──────▶ sales-opt ingest ──▶ so_call_facts
Stripe ──verified webhook──▶ payments (existing) ──▶ attribution (15-min job) ──▶ so_attributions
so_call_facts + calls.transcript (consented) ──▶ analysis jobs ──runner──▶ Ollama/Qwen ──▶ grounded so_findings
so_findings + metrics ──▶ proposal job ──runner──▶ candidate so_versions (author ai) ──▶ evaluation (19 scenarios)
Founder: approve ──▶ deploy staging (read-back verified) ──▶ deploy production (gated) ──▶ monitor ──▶ auto-rollback
```

| Layer | Files |
|---|---|
| Schema | `migrations/0047_sales_optimization.sql` |
| Pure rules | `src/domain/sales-opt/policy.ts` (protected policy), `analysis.ts` (grounding, proposals), `evaluation.ts` (scenarios, assertions), `stats.ts` (Wilson CI, experiments, safety) |
| Services | `src/services/sales-opt/registry.ts`, `ingest.ts`, `attribution.ts`, `metrics.ts`, `jobs.ts`, `deploy.ts`, `monitor.ts` |
| UI | `/staff/sales-optimization`, `/staff/sales-optimization/versions/:id` (`src/routes/sales-optimization.ts`) |
| Schedule | job `sales_opt`, every 15 minutes (`src/app/scheduled.ts`) |

### Key design decisions
- **Outcomes, not opinions.** Conversion means webhook-verified payments on an order linked to the call's lead, within a 14-day window. It uses last-touch for headline numbers and equal multi-touch credit as well. Refunded, disputed and cancelled sales are excluded from revenue. What the agent says, the call summary and model scores never create a sale.
- **Grounded analysis.** A finding is *observed* only if its quote appears verbatim in the consented transcript. Otherwise it is *interpreted*, with confidence capped at 0.5. Deterministic detectors (invented prices, guarantees, discounts, payment terms, refund promises, pressure, human impersonation, card details) run without the model. Safety monitoring therefore works even when the runner is down.
- **Protected policy.** Every deployed prompt is `PROTECTED_SALES_POLICY` (generated from `src/domain/catalog.ts`) followed by the optimizable instructions. `salesPolicyViolations` rejects instructions that contradict the policy. It runs on creation, at evaluation and immediately before deployment. The checks are pattern-based and can miss paraphrases, so the evaluation harness and Founder review are further layers, not optional extras.
- **Immutable versions.** Database triggers refuse any change or deletion of version content. Versions cite findings by id only, so transcript quotes stay where retention can purge them.
- **No silent production change.** Production needs all of the following: `ENVIRONMENT=production`, `SALES_OPT_PRODUCTION=on`, the Founder's activation switch (step-up MFA), a Founder-approved version, a prior verified staging deployment of that same version, a verified retell-llm target that is not the receptionist, a compare-and-swap on the expected current version, and the single in-flight lock. A deployment is *verified* only when Retell's read-back equals the composed prompt exactly. On a mismatch the snapshot is restored.
- **No paid AI.** All model work uses the existing self-hosted runner channel. Jobs are internal (`status succeeded`) and never enter the draft-approval queue. Their inputs and outputs are deleted once consumed.

## 3. Founder controls and gates

| Control | Where | Default |
|---|---|---|
| Pause optimization (no new analyses or proposals; monitoring continues) | Dashboard → Founder controls | **Paused** |
| Production activation | Dashboard → Founder controls (step-up) + `SALES_OPT_PRODUCTION=on` | **Off** |
| Automatic rollback on safety breach | Dashboard → Founder controls | On |
| Safety thresholds (min sample 50; opt-out 15%, compliance 2%, complaint 5%, error 5%, refund 20%) | Dashboard → Founder controls | Conservative defaults |
| Approve / reject version | Version page (Owner only, step-up) | — |
| Deploy staging / production, roll back | Version page / deployment history (Owner only, step-up) | — |
| Start / stop experiment | Dashboard → Experiments (Owner only, step-up) | — |

Safety breaches are judged on the lower bound of the 95% Wilson interval, apart from compliance, which uses the point estimate. Experiments never promote automatically. "Candidate better" requires the whole 95% interval of the conversion difference to be above zero, with at least the Founder-set minimum of connected calls per arm (at least 100) and no safety breach.

## 4. Staging activation (SALESOPT-012)

The end-to-end flow has **not** been demonstrated. To run it on staging:
1. Create two Retell agents that are *not* the receptionist (for example "Crestmont Sales — staging" and "— production"), each with a Retell LLM. Give them the same custom functions as the receptionist (`RETELL-INTEGRATION.md` §6) and the webhook URL `https://<staging host>/api/webhooks/retell`.
2. Set `RETELL_API_KEY` as a staging Worker secret. Register the staging agent id on the dashboard and press **Verify with Retell**.
3. Enable AI drafts on the runner (`docs/ai-builds/RUNNER-SETUP.md`). Sales-opt jobs use the same claim endpoint.
4. Unpause optimization. Run version 1's evaluation and review the 19 simulated transcripts. Deploy to the staging agent and check the read-back.
5. Place **web/test calls** from the Retell dashboard (they are marked as tests and excluded from metrics) and record consent. Confirm ingestion, analysis and findings.
6. Create a Stripe test-mode order for a lead linked by metadata `crestmont_lead_id` on a non-test staging call, then confirm attribution.

Production stays untouched until the Founder sets `SALES_OPT_PRODUCTION=on` on production, activates it on the dashboard, and approves a version.

## 5. Experiments (dialler contract)

`experimentRouting(db, leadKey)` returns `{ experimentId, arm, versionId }` for the single running experiment, using a deterministic SHA-256 bucket. Whatever creates sales calls must:
- place the call with the agent or version that holds `versionId`, and stamp `metadata.crestmont_so_version = versionId` and `metadata.crestmont_so_experiment = experimentId`;
- stamp `metadata.crestmont_lead_id` and optionally `metadata.crestmont_segment` (`[a-z0-9_-]{1,40}`) so cohorts can be compared like for like.

**Nothing in this repository places sales calls.** Running an experiment also needs a second Retell agent or version holding the candidate prompt. Both are deliberately left to the separate, counsel-reviewed dialler change.

## 6. Operations

- **Scheduled job `sales_opt`** (every 15 minutes) prunes webhook receipts, reconciles attribution, purges evidence quotes whose transcript has been deleted, consumes finished runner jobs, queues new analyses and one proposal a day (unless paused), monitors live versions (auto-rollback) and monitors experiments (safety stop). Its status is recorded in `ingestion_status` like every job.
- **Runner offline:** jobs still not done after 6 hours are abandoned. Analyses then complete with deterministic findings only, and evaluations end as `error` (the version does not pass).
- **Worker restart:** every step is a compare-and-swap or idempotent upsert. An `in_progress` deployment left by a crash blocks that stage until it is marked `aborted` in D1 after checking the agent in Retell. Do this on purpose, never automatically.
- **Retention and erasure:** transcripts stay in `calls.transcript` (consent-gated, `retention.voice_transcripts_days`, caller erasure). Evidence quotes are cleared on the next cycle once the transcript is gone, and versions hold no transcript text.
- **Access:** dashboard `salesopt.read` and decisions `salesopt.decide` are both Owner-only, and every decision needs step-up MFA. API keys are never rendered or logged.
- **Alerts:** failed/aborted deployments, every production deployment, safety breaches and automatic experiment stops notify every Owner in the app.

## 7. Known gaps

- No sales agent, sales dialler or checkout-link tool exists. `checkout_link_generated` is recorded only if a future `send_checkout_link` function appears in the call's tool invocations.
- Publishing a Retell version and pinning the phone number are manual steps.
- Conversation-flow and custom-LLM agents are not supported, and the engine refuses them.
- The policy checks and scenario assertions are heuristics. Offline simulation shows only policy adherence on scripted scenarios, not real-world sales improvement.
- The quality of the local model's analysis and proposals is unmeasured until real consented calls exist.
