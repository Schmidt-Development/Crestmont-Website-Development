# E2E benchmark: simulated $2,500 purchase → real AI website build ("Junk in the Trunk")

Founder directive, 2026-10-30. This file covers what was built for the benchmark, what has been tested, and the exact steps for the parts that need Node 1.

**Only the payment provider is simulated.** Stripe is not configured. Everything downstream of the payment is the real application workflow: the CRM lead, the quote, customer registration and email verification, proposal acceptance, project provisioning, onboarding, build eligibility, the GPU worker dispatch, and the V4 orchestrator and private review.

## 1. Where a real payment authorizes fulfillment

A verified Stripe webhook arrives at `POST /api/webhooks/stripe`, which calls `processStripeEvent`, and that calls **`confirmInvoicePayment`** in `src/services/payments.ts`. `confirmInvoicePayment` then does four things:

1. `markInvoicePaid`: marks the invoice paid, records the payment row, and updates the order status.
2. `provisionProject`: creates the project for the first invoice (full or 50% deposit).
3. `syncProjectBuildSafe`: re-evaluates the first AI build.
4. Lead conversion and the receipt email.

`confirmInvoicePayment` was `applyInvoicePayment` before this change. It is now provider-neutral and exported. The Stripe path behaves exactly as before. The simulation adapter calls the same function with `{ provider: "simulated" }`.

## 2. The test-only payment adapter (`src/services/payment-simulation.ts`, migration 0044)

| Control | Where |
|---|---|
| Owner-only permission `payments.simulate` (AI and system actors never hold it); MFA step-up on both actions | `src/domain/authz.ts`, `src/app/step-up.ts` |
| Allowed only when `ENVIRONMENT` is `development` or `staging` (an allow-list, so a missing or misspelled value fails closed) and `PAYMENT_SIMULATION_ENABLED="true"` | `assertSimulationAllowed` |
| Pays only organizations the Owner marked as fictional test organizations (the exact name must be typed). Every member must use a reserved test address (`.test`, `.example`, `.invalid`, `.localhost`) or `@crestmontwebsitedevelopment.com`, and the organization must have no Stripe payment. Both rules are re-checked on every event, not only when marking | `fictionalOrgProblem`, `markTestOrganization`, `evaluate` |
| Only open invoices can be paid; void or other non-open invoices are rejected | `evaluate` |
| A real Stripe payment for an invoice already paid by simulation is never acknowledged silently: the Stripe event fails, is retried, then dead-letters, so it shows in reconciliation | `markInvoicePaid` |
| Event fields: event id, transaction id, order, invoice, customer, package, amount (cents), currency, `SIMULATED_PAID` / `SIMULATED_FAILED`, timestamp, environment, correlation id | `SimulatedPaymentEvent` |
| Deterministic: the same inputs always give the same event and transaction ids | `createSimulatedEvent` |
| Stored once per event id. A duplicate delivery returns the original outcome and is never re-applied | `deliverSimulatedEvent` |
| Rejected: wrong amount or currency; wrong order, package or customer; another environment; timestamp outside 5 minutes; a transaction id re-sent under a new event id; unknown status; forged schema | `evaluate` |
| Duplicate-order protection: a paid invoice records no second payment; a unique index allows one simulated payment per invoice | `evaluate`, migration 0044 |
| No receipt email, no receipt page or PDF, not refundable. Payment rows are `provider='simulated'` with no Stripe ids, and the CRM note says SIMULATED | `confirmInvoicePayment`, `loadReceipt`, `customerBilling`, `requestRefund` |
| Not revenue: excluded from the finance dashboard (gross, net, by month, by kind, order value), the Owner dashboard revenue, CRM customer totals and revenue by source, and invoice documents. The transactions CSV labels these rows "SIMULATED (test, not revenue)" | `finance.ts`, `owner.ts`, `crm.ts`, `finance-documents.ts` |
| Never authorizes real fulfillment: a simulated payment from an unmarked organization makes the build ineligible, and unmarking cancels it. Customer preview sharing, AI-builder production release, manual deployment recording (release readiness) and handoff publishing are all refused | `decideEligibility`, `sharePreview`, `releaseBlockers` / `insertDeployment`, `releaseReadiness`, `saveHandoff` |
| Owner page **Staff → `/staff/test-payments`**: open invoices, mark a test organization, deliver an event, event log | `src/routes/test-payments.ts` |

**Not tested** (Stripe is not configured): Stripe Checkout, Stripe signature verification, settlement, payouts, refunds and disputes.

## 3. What is tested now (`tests/e2e-simulated-purchase.test.ts`, real routes on in-memory SQLite)

- **AIB-020 (E2E).** The full flow for Junk in the Trunk:
  - A public quote form creates the lead.
  - The Owner writes a custom quote of exactly $2,500.00 and sends it.
  - The fictional customer registers, verifies their email and accepts.
  - The order and the deposit invoice are created, and the CRM company is matched to the customer organization.
  - Real checkout is unavailable, because Stripe is not configured.
  - The simulated payment is refused until the organization is marked, then applied.
  - The project is provisioned and the lead converts; no receipt is sent.
  - A second simulation is a duplicate order and records nothing.
  - The real onboarding form is submitted; re-submitting creates no second build.
  - Exactly one build is queued, with 7 pages and the quote-flow requirement in the brief.
  - The registered GPU worker claims it through the signed runner protocol.
  - **The test stops at dispatch: no model is called.**
- **AIB-019 (adapter).** Success, duplicate delivery, duplicate order, incorrect amount, incorrect currency, failed payment, stale replay, transaction replay, forged events, a real customer refused, and a Stripe-paid organization that cannot be marked.
- **AIB-019 (authorization).** Unauthorized attempts:
  - production;
  - the flag off;
  - every non-Owner staff role;
  - a customer;
  - an anonymous visitor.

  None of them reaches the adapter.
- **AIB-019 (fulfillment guard).** A simulated payment never authorizes fulfillment:
  - the customer preview share is refused;
  - production release is blocked;
  - unmarking the organization cancels the build.

## 4. Decisions needed before the real run

1. **Package and QA path (important).** A $2,500 order can't be a catalog package: Business is $2,499, and public pricing must not change. So it has to be a custom quote, and under **CAT-004** custom quotes are billed 50/25/25. That has two consequences:
   - The payment that unlocks fulfillment is the **$1,250 deposit (125,000 cents)**, not one 250,000-cent payment. The order total is exactly 250,000 cents.
   - The build uses the runner's **custom** strategy. That strategy has no approved starter, no starter `npm run check` (HTML, links, SEO, accessibility basics, responsive CSS, leftovers) and no runner-side headless screenshots. For a 7-page marketing site, most of the Phase 4 QA would then not be enforced by the runner.

   The options are:
   - **(a) Recommended:** run the benchmark as the **Business package ($2,499.00, 100% upfront)**. It uses the standard website pipeline with the brochure starter, its checks and the runner's browser screenshots. The simulated event is then 249,900 cents.
   - **(b)** Keep the $2,500 custom quote and accept the deposit semantics and the weaker QA.
   - **(c)** Authorize a code change, such as an internal non-public test package or an upfront schedule for custom quotes. Each one changes CAT-004 or the catalog.
2. **Merge and migrations.** Staging migrates only from `main`. The real run needs PR #16 and this branch merged, with migrations 0041 to 0044 applied to staging.
3. **Enable the simulation on staging only.** Add `PAYMENT_SIMULATION_ENABLED = "true"` to the staging `vars` in `wrangler.toml`. Production ignores it in every case.
4. **The fictional customer's email.** Staging only delivers to the allow-list (`@crestmontwebsitedevelopment.com`), and email verification needs a delivered link. Use an allow-listed address such as `e2e+junkinthetrunk@crestmontwebsitedevelopment.com` for the customer, or add a specific test address to `EMAIL_RECIPIENT_ALLOWLIST`.

## 5. The real run (staging + Node 1), after the decisions above

1. Install Node 1 per ORCHESTRATOR.md §13. Confirm it with `Get-RunnerHealth.ps1`, then `ollama ps` (100% GPU), then the benchmark.
2. On staging, do the following as the Owner:
   1. Submit the public `/quote` form with the Junk in the Trunk details (`tests/fixtures/junk-in-the-trunk.ts`).
   2. Create the quote (decision 1) and send it.
   3. As the customer, register, verify, sign in and accept.
   4. In **`/staff/test-payments`**, type the name to mark "Junk in the Trunk" as a test organization, then deliver `SIMULATED_PAID`.
3. As the customer, submit onboarding with the fixture's intake answers.
4. The build is queued and Node 1 claims it. Watch **Owner → AI builds** (pipeline, GPU workers, the build page).
5. The build finishes in **AWAITING_INTERNAL_APPROVAL**. Do not internally approve, share or release it. Sharing and release are refused for this project anyway.

### Evidence to collect for the Phase 6 report

| Metric | Source |
|---|---|
| Node 1 execution, GPU use, VRAM | GPU workers page (from the host `nvidia-smi` sampler), `state\telemetry\gpu.json`, `ollama ps` |
| Model A and B inference metrics, switch time | GPU workers page (per-model tokens/s, switch log), the runner log, `npm run benchmark` output |
| Review and repair cycles, model per cycle | build page (cycles table: builder and reviewer model, routing) |
| Total build time | build events (claimed → ready_for_review) |
| Automated tests | the build page's runner checks, `.crestmont/runner-checks.json`, requirement statuses |
| Screenshots and private preview | `.crestmont/screenshots/` in the project repository, and the gated preview URL (needs the Cloudflare preview account; otherwise there is no preview) |
| Human interventions | build events; anything in needs-information |

Other customer-facing emails the real workflow sends, such as onboarding, project updates and milestone invoices, go to the test organization's members. The address rule above means those are only reserved test addresses or Crestmont's own domain.

An independent review found six defects in the first version. All six are fixed and covered by regression tests:
1. A test mark was not re-checked after real money arrived.
2. A real Stripe payment was silently dropped on an invoice already paid by simulation.
3. Void invoices could be paid.
4. Release was possible through the manual delivery path.
5. Simulated money was counted as revenue.
6. Follow-up errors were mislabelled as duplicate orders.

Two gaps remain. The step-up requirement is proven by the route map rather than by an HTTP request with a stale session. A build that is already running when the organization is unmarked is stopped through the existing "no longer eligible" stop request, which this test does not exercise.

## 6. Known QA gaps (not hidden, not yet fixed)

- The runner captures **desktop and mobile** screenshots only. There is no tablet width.
- There is no automated **performance** or full **accessibility** audit (Lighthouse or axe). The starter check covers accessibility basics only.
- Browser console errors are not collected as a pass/fail check.
- Custom-strategy builds get none of the starter checks (decision 1).
- The quote-request form in the starter posts to a stub endpoint. "Working" means validated and confirmed in the isolated environment; nothing is delivered anywhere.
