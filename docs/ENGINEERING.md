# Crestmont engineering conventions

Binding rules for everyone working in this repository. The master directive (Founder-approved, Oct 2026) is the scope; `requirements/inventory.ts` is its 154-item registry.

## Non-negotiables
- **Real software only.** Every page reads and writes real database rows. No hard-coded sample records, no fake metrics, no buttons that do nothing, no "coming soon" controls. If a capability depends on an external account that does not exist yet (Stripe, Resend, Cloudflare, voice provider), the UI says so plainly ("Online payment is not configured yet") and the integration-health record says `not_configured`. Never simulate success.
- **Test fixtures only in tests / dev seed**, and they are labelled as test data.
- **Authorization on the server.** Every route calls a guard from `src/app/app.ts`: `requireStaff(ctx, perm)` for staff areas (also enforces MFA), `requireCustomerOrg(ctx)` for the portal, and every customer query is scoped by `organization_id = ?` from that guard — never from a URL or form field. Record-level checks (assigned lead, assigned task) happen in services.
- **Founder-protected actions** (`refund.decide`, `refund.issue`, `pricing.change`, `release.approve_production`, `release.deploy_production`, `security.exception`) are Owner-only and are never available to AI or automation. Do not add bypasses.
- **No live payments, no phone number purchase, no production deploy.** Stripe adapter refuses live keys.
- **Never invent business facts** (customer counts, awards, ratings, years in business, testimonials, delivery-time guarantees). Unknown costs are `NULL`, displayed "Unknown", never 0.
- **Portfolio**: the three portfolio sites are Founder-related projects (see `docs/BUILD_LEDGER.md`). Never AI-generated or stock screenshots. Where a genuine screenshot does not exist, show the honest pending state (`.shot--pending`) and keep the requirement blocked.

## Stack and code style
- Node ≥ 22.18 runs TypeScript natively: **erasable syntax only** — no `enum`, no constructor parameter properties (`constructor(private x)`), no namespaces. Import local files with the `.ts` extension.
- No npm dependencies (registry unavailable in the build workspace). Use Web APIs + the repo's own libs.
- HTML is built with the tagged template `html` from `src/lib/html.ts` (auto-escapes). Use `raw()` only for static markup written in the repo. URLs into `href`/`src` go through `safeUrl()`.
- UI building blocks: `src/ui/components.ts` (inputs, selects, tables, badges, KPIs, empty states, tabs, pagination, action forms), shells in `src/ui/layout.ts` (`publicLayout`, `appLayout`, `authLayout`), navigation in `src/routes/nav.ts`. Styles: `public/assets/app.css` — reuse existing classes; add new CSS only at the end of the file inside a clearly commented block for your area.
- Forms: plain HTML forms that work without JavaScript, `method="post"`, include `${csrf(ctx)}`. CSRF is enforced centrally for every non-GET, non-`/api/` route. After a successful POST, `redirect(ctx, path, { kind: "success", text })` (PRG pattern). On validation errors, re-render with `formErrors([...])` and status 400/422.
- SQL: D1/SQLite dialect, always parameterised with `.bind()`. Multi-statement writes go in `db.batch([...])` (atomic). Money = integer cents. Timestamps = ISO strings from `nowIso()`. IDs = `newId("prefix")`.
- Every state-changing action on business records writes an audit entry: `audit(db, {...})` from `src/services/security.ts`.
- Notifications to people: `sendMail(ctx, {...})` from `src/services/mailer.ts` (template names are listed there) and/or a row in `notifications`.
- New schema goes in a **new** migration file with your assigned number. Never edit existing migrations.
- Each product area owns its route module in `src/routes/` (already registered in `src/routes/index.ts`) and its status file in `requirements/status/`. Do not edit other areas' files; if you need something from another area, read its code and use it, or put a small shared helper in your own module.

## Tests and readiness evidence
- Tests live in `tests/<area>.test.ts`, use `node:test` + `node:assert/strict`, and drive the real pipeline with the harness in `tests/support/app.ts` (`createTestApp`, `TestClient.login/get/post`, `createStaff`, `createCustomer`, `lastEmail`).
- Every test name starts with the requirement it proves: `test("[CRM-005] ...", ...)`. Only use IDs that exist in `requirements/inventory.ts`; never edit the inventory.
- Run only your file while working: `node --no-warnings --test tests/<area>.test.ts`. The full suite (`npm test`) writes evidence; the integrator runs it.
- Typecheck: `/opt/node22/lib/node_modules/typescript/bin/tsc -p tsconfig.json` (fix errors in your files).
- Implementation status is recorded **explicitly** in your `requirements/status/<area>.ts`. A requirement is `implemented` only when every applicable layer exists (UI, server, persistence, authz, validation, errors, empty states, audit/notifications, tests). Otherwise `in_progress` with an honest `missing` note. Passing tests alone never justify `implemented`.
