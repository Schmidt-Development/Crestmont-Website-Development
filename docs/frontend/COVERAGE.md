# Route & surface coverage — frontend redesign

Generated 2026-10-27 from `listRoutes()` (every registered GET route) joined with the local Chromium crawl
(seeded development server, roles: public, customer, owner, sales, support, developer; widths 1280 and 360px;
screenshot set adds 320/414/820/1680). **Local verification only** — design v3 @ `c60be7d`. The (now retired) hosted preview was verified by CI to serve these exact assets
byte-for-byte (Actions run 40596685833; historical). Hosted verification is now done on staging by `deploy-staging.yml`.

| | Count |
|---|---|
| GET route patterns | 178 |
| Rendered and checked (layout overflow, console errors, one h1, one main, images) | 126 |
| Open issues | 0 |
| Styled by the shared system, not reached by the crawl (need specific records/tokens) | 20 |
| No page UI (JSON, files, SEO, downloads) | 32 |

Every HTML surface renders through `publicLayout`, `authLayout` or `appLayout` and the shared components, so all routes —
including those not reached — receive the new design system; "not reached" means not individually screenshot-verified.

## API (JSON, no UI) (7)

| Route | Status | Roles crawled | Widths |
|---|---|---|---|
| `/api/health` | n/a (no page UI) | — | — |
| `/api/readiness` | n/a (no page UI) | — | — |
| `/api/readiness/requirements.csv` | n/a (no page UI) | — | — |
| `/api/readiness/health` | n/a (no page UI) | — | — |
| `/api/readiness/release-authorization` | n/a (no page UI) | — | — |
| `/api/builds` | n/a (no page UI) | — | — |
| `/api/builds/:id` | n/a (no page UI) | — | — |

## Authentication & account (10)

| Route | Status | Roles crawled | Widths |
|---|---|---|---|
| `/login` | ✅ rendered & checked | public, customer, owner, sales, support, developer | 1280 + 360 |
| `/register` | ✅ rendered & checked | public | 1280 + 360 |
| `/verify-email` | ✅ rendered (400 for crawled roles) | public | 1280 + 360 |
| `/mfa` | ✅ rendered & checked | public | 1280 + 360 |
| `/mfa/setup` | ✅ rendered & checked | customer | 1280 + 360 |
| `/password/forgot` | ✅ rendered & checked | public | 1280 + 360 |
| `/password/reset` | ✅ rendered & checked | public | 1280 + 360 |
| `/invite` | ✅ rendered (400 for crawled roles) | public | 1280 + 360 |
| `/account` | ✅ rendered & checked | customer, owner, sales, support, developer | 1280 + 360 |
| `/account/privacy` | ✅ rendered & checked | customer | 1280 + 360 |

## Customer portal (27)

| Route | Status | Roles crawled | Widths |
|---|---|---|---|
| `/portal` | ✅ rendered & checked | customer | 1280 + 360 |
| `/portal/projects` | ✅ rendered & checked | customer | 1280 + 360 |
| `/portal/projects/:id` | ✅ rendered & checked | customer | 1280 + 360 |
| `/portal/projects/:id/onboarding` | ✅ rendered & checked | customer | 1280 + 360 |
| `/portal/files` | ✅ rendered & checked | customer | 1280 + 360 |
| `/portal/projects/:id/files` | ✅ rendered & checked | customer | 1280 + 360 |
| `/portal/files/:id` | styled by shared system · not reached by crawl | — | — |
| `/portal/messages` | ✅ rendered & checked | customer | 1280 + 360 |
| `/portal/messages/general` | ✅ rendered & checked | customer | 1280 + 360 |
| `/portal/projects/:id/messages` | ✅ rendered & checked | customer | 1280 + 360 |
| `/portal/projects/:id/revisions` | ✅ rendered & checked | customer | 1280 + 360 |
| `/portal/approvals` | ✅ rendered & checked | customer | 1280 + 360 |
| `/portal/projects/:id/approvals` | ✅ rendered & checked | customer | 1280 + 360 |
| `/portal/projects/:id/handoff` | ✅ rendered & checked | customer | 1280 + 360 |
| `/portal/team` | ✅ rendered & checked | customer | 1280 + 360 |
| `/portal/support` | ✅ rendered & checked | customer | 1280 + 360 |
| `/portal/support/new` | ✅ rendered & checked | customer | 1280 + 360 |
| `/portal/support/:id` | ✅ rendered & checked | customer | 1280 + 360 |
| `/portal/billing` | ✅ rendered & checked | customer | 1280 + 360 |
| `/portal/billing/invoices/:id` | ✅ rendered & checked | customer | 1280 + 360 |
| `/portal/billing/invoices/:id/pdf` | n/a (no page UI) | — | — |
| `/portal/billing/receipts/:paymentId/pdf` | n/a (no page UI) | — | — |
| `/portal/agreements` | ✅ rendered & checked | customer | 1280 + 360 |
| `/portal/billing/receipts/:paymentId` | ✅ rendered & checked | customer | 1280 + 360 |
| `/portal/notifications` | ✅ rendered & checked | customer | 1280 + 360 |
| `/portal/maintenance` | ✅ rendered & checked | customer | 1280 + 360 |
| `/portal/projects/:id/build-status` | styled by shared system · not reached by crawl | — | — |

## Owner — command center (1)

| Route | Status | Roles crawled | Widths |
|---|---|---|---|
| `/staff/owner` | ✅ rendered & checked | owner | 1280 + 360 |

## Owner — launch readiness (19)

| Route | Status | Roles crawled | Widths |
|---|---|---|---|
| `/staff/readiness` | ✅ rendered & checked | owner, sales, support, developer | 1280 + 360 |
| `/staff/readiness/requirements` | ✅ rendered & checked | owner, sales, support, developer | 1280 + 360 |
| `/staff/readiness/requirements/:id` | ✅ rendered & checked | owner, sales, support, developer | 1280 + 360 |
| `/staff/readiness/runs/:id` | styled by shared system · not reached by crawl | — | — |
| `/staff/readiness/engineering` | ✅ rendered & checked | owner, sales, support, developer | 1280 + 360 |
| `/staff/readiness/env/:env` | ✅ rendered & checked | owner, sales, support, developer | 1280 + 360 |
| `/staff/readiness/blockers` | ✅ rendered & checked | owner, sales, support, developer | 1280 + 360 |
| `/staff/readiness/blockers/new` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/readiness/blockers/:id` | ✅ rendered & checked | owner, sales, support, developer | 1280 + 360 |
| `/staff/readiness/security` | ✅ rendered & checked | owner, sales, support, developer | 1280 + 360 |
| `/staff/readiness/releases` | ✅ rendered & checked | owner, sales, support, developer | 1280 + 360 |
| `/staff/readiness/approve` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/readiness/export.csv` | n/a (no page UI) | — | — |
| `/staff/readiness/packet.json` | n/a (no page UI) | — | — |
| `/staff/readiness/report` | ✅ rendered & checked | owner, sales, support, developer | 1280 + 360 |
| `/staff/readiness/snapshots` | ✅ rendered & checked | owner, sales, support, developer | 1280 + 360 |
| `/staff/readiness/snapshots/:id` | styled by shared system · not reached by crawl | — | — |
| `/staff/readiness/founder-report` | ✅ rendered & checked | owner, sales, support, developer | 1280 + 360 |
| `/staff/readiness/founder-report.md` | n/a (no page UI) | owner, sales, support, developer | 1280 + 360 |

## Public website (14)

| Route | Status | Roles crawled | Widths |
|---|---|---|---|
| `/` | ✅ rendered & checked | public, customer, owner, sales, support, developer | 1280 + 360 |
| `/services` | ✅ rendered & checked | public, customer, owner, sales, support, developer | 1280 + 360 |
| `/services/hosting-maintenance` | ✅ rendered & checked | public | 1280 + 360 |
| `/services/:slug` | ✅ rendered & checked | public, customer, owner, sales, support, developer | 1280 + 360 |
| `/pricing` | ✅ rendered & checked | public, customer, owner, sales, support, developer | 1280 + 360 |
| `/pricing/compare` | ✅ rendered & checked | public, customer, owner, sales, support, developer | 1280 + 360 |
| `/portfolio` | ✅ rendered & checked | public, customer, owner, sales, support, developer | 1280 + 360 |
| `/portfolio/:slug` | ✅ rendered (404 for crawled roles) | public | 1280 + 360 |
| `/about` | ✅ rendered & checked | public, customer, owner, sales, support, developer | 1280 + 360 |
| `/process` | ✅ rendered & checked | public, customer, owner, sales, support, developer | 1280 + 360 |
| `/faq` | ✅ rendered & checked | public, customer, owner, sales, support, developer | 1280 + 360 |
| `/hosting-maintenance` | ✅ rendered & checked | public, customer, owner, sales, support, developer | 1280 + 360 |
| `/contact` | ✅ rendered & checked | public, customer, owner, sales, support, developer | 1280 + 360 |
| `/contact/thanks` | ✅ rendered & checked | public | 1280 + 360 |

## Public — policies (4)

| Route | Status | Roles crawled | Widths |
|---|---|---|---|
| `/legal` | ✅ rendered & checked | public, customer, owner, sales, support, developer | 1280 + 360 |
| `/legal/:slug` | ✅ rendered & checked | public, customer, owner, sales, support, developer | 1280 + 360 |
| `/legal/:kind/versions` | ✅ rendered & checked | owner, sales, support | 1280 + 360 |
| `/legal/:kind/versions/:version` | ✅ rendered & checked | owner, sales, support | 1280 + 360 |

## SEO files (no UI) (2)

| Route | Status | Roles crawled | Widths |
|---|---|---|---|
| `/robots.txt` | n/a (no page UI) | — | — |
| `/sitemap.xml` | n/a (no page UI) | — | — |

## Staff — delivery (6)

| Route | Status | Roles crawled | Widths |
|---|---|---|---|
| `/staff/projects/export.csv` | n/a (no page UI) | — | — |
| `/staff/projects` | ✅ rendered & checked | owner, support, developer | 1280 + 360 |
| `/staff/projects/:id` | ✅ rendered & checked | owner, sales, support, developer | 1280 + 360 |
| `/staff/tasks/export.csv` | n/a (no page UI) | — | — |
| `/staff/tasks` | ✅ rendered & checked | owner, support, developer | 1280 + 360 |
| `/staff/tasks/:id` | ✅ rendered & checked | owner, developer | 1280 + 360 |

## Staff — finance & reports (17)

| Route | Status | Roles crawled | Widths |
|---|---|---|---|
| `/staff/reports/operations` | ✅ rendered & checked | owner, sales, support, developer | 1280 + 360 |
| `/staff/reports/operations/summary.csv` | n/a (no page UI) | — | — |
| `/staff/reports/operations/time.csv` | n/a (no page UI) | — | — |
| `/staff/refunds` | ✅ rendered & checked | owner, support | 1280 + 360 |
| `/staff/refunds/:id` | styled by shared system · not reached by crawl | — | — |
| `/staff/disputes` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/finance` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/finance/subscriptions` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/finance/invoices` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/finance/invoices/:id` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/finance/invoices/:id/pdf` | n/a (no page UI) | — | — |
| `/staff/finance/receipts/:paymentId/pdf` | n/a (no page UI) | — | — |
| `/staff/finance/profitability` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/reports` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/reports/:file` | styled by shared system · not reached by crawl | — | — |
| `/staff/finance/receipts/:paymentId` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/finance/reconciliation` | ✅ rendered & checked | owner | 1280 + 360 |

## Staff — platform & admin (38)

| Route | Status | Roles crawled | Widths |
|---|---|---|---|
| `/staff/cms` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/cms/revisions/:id` | styled by shared system · not reached by crawl | — | — |
| `/staff/cms/revisions/:id/compare` | styled by shared system · not reached by crawl | — | — |
| `/staff/cms/:key` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/portfolio` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/portfolio/files/:fileId` | styled by shared system · not reached by crawl | — | — |
| `/staff/portfolio/:id` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff` | ✅ rendered & checked | owner, sales, support, developer | 1280 + 360 |
| `/staff/employees` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/employees/export.csv` | n/a (no page UI) | — | — |
| `/staff/employees/:id` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/email/export.csv` | n/a (no page UI) | — | — |
| `/staff/email` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/email/templates` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/email/templates/:name/html` | ✅ rendered (0 for crawled roles) | owner | 1280 + 360 |
| `/staff/email/:id` | styled by shared system · not reached by crawl | — | — |
| `/staff/email/:id/html` | styled by shared system · not reached by crawl | — | — |
| `/staff/integrations` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/monitoring` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/security` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/security/events.csv` | n/a (no page UI) | — | — |
| `/staff/audit` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/audit/export.csv` | n/a (no page UI) | — | — |
| `/staff/backups` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/settings` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/ai/export.csv` | n/a (no page UI) | — | — |
| `/staff/ai` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/ai/:id` | styled by shared system · not reached by crawl | — | — |
| `/staff/voice` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/voice/configs/diff` | styled by shared system · not reached by crawl | — | — |
| `/staff/voice/calls/:id` | styled by shared system · not reached by crawl | — | — |
| `/staff/legal` | ✅ rendered & checked | owner, sales, support | 1280 + 360 |
| `/staff/email-suppressions` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/ops` | ✅ rendered & checked | owner, sales, support, developer | 1280 + 360 |
| `/staff/ops/retention` | ✅ rendered & checked | owner, sales, support, developer | 1280 + 360 |
| `/staff/notifications` | ✅ rendered & checked | owner, sales, support, developer | 1280 + 360 |
| `/staff/builds` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/builds/:id` | styled by shared system · not reached by crawl | — | — |

## Staff — sales & CRM (16)

| Route | Status | Roles crawled | Widths |
|---|---|---|---|
| `/staff/crm` | ✅ rendered & checked | owner, sales | 1280 + 360 |
| `/staff/crm/export.csv` | n/a (no page UI) | — | — |
| `/staff/crm/new` | ✅ rendered & checked | owner, sales | 1280 + 360 |
| `/staff/crm/contacts` | ✅ rendered & checked | owner, sales | 1280 + 360 |
| `/staff/crm/duplicates` | ✅ rendered & checked | owner, sales | 1280 + 360 |
| `/staff/crm/leads/:id` | ✅ rendered & checked | owner, sales | 1280 + 360 |
| `/staff/crm/leads/:id/quick` | ✅ rendered & checked | owner, sales | 1280 + 360 |
| `/staff/customers` | ✅ rendered & checked | owner, sales, support | 1280 + 360 |
| `/staff/customers/export.csv` | n/a (no page UI) | — | — |
| `/staff/customers/:id` | ✅ rendered & checked | owner, sales, support | 1280 + 360 |
| `/staff/sales` | ✅ rendered & checked | owner, sales | 1280 + 360 |
| `/staff/quotes` | ✅ rendered & checked | owner, sales | 1280 + 360 |
| `/staff/quotes/export.csv` | n/a (no page UI) | — | — |
| `/staff/quotes/new` | ✅ rendered & checked | owner, sales | 1280 + 360 |
| `/staff/quotes/:id` | styled by shared system · not reached by crawl | — | — |
| `/staff/pricing` | ✅ rendered & checked | owner, sales | 1280 + 360 |

## Staff — support (6)

| Route | Status | Roles crawled | Widths |
|---|---|---|---|
| `/staff/conversations` | ✅ rendered & checked | owner, sales, support | 1280 + 360 |
| `/staff/conversations/:orgId` | ✅ rendered & checked | owner, sales, support | 1280 + 360 |
| `/staff/support/export.csv` | n/a (no page UI) | — | — |
| `/staff/support` | ✅ rendered & checked | owner, support | 1280 + 360 |
| `/staff/support/settings` | ✅ rendered & checked | owner | 1280 + 360 |
| `/staff/support/:id` | ✅ rendered & checked | owner, support | 1280 + 360 |

## Token, file & checkout endpoints (11)

| Route | Status | Roles crawled | Widths |
|---|---|---|---|
| `/portfolio-media/:fileId` | n/a (no page UI) | — | — |
| `/quote` | ✅ rendered & checked | public, customer, owner, sales, support, developer | 1280 + 360 |
| `/quote/thanks` | ✅ rendered & checked | public | 1280 + 360 |
| `/files/:id` | styled by shared system · not reached by crawl | — | — |
| `/files/:id/preview` | n/a (no page UI) | — | — |
| `/files/:id/share` | styled by shared system · not reached by crawl | — | — |
| `/share/:token` | styled by shared system · not reached by crawl | — | — |
| `/q/:token` | styled by shared system · not reached by crawl | — | — |
| `/checkout/maintenance/:planId` | ✅ rendered & checked | public | 1280 + 360 |
| `/checkout/:packageId` | ✅ rendered & checked | public, customer, owner, sales, support, developer | 1280 + 360 |
| `/live/unread` | n/a (no page UI) | — | — |

## States covered

| State | Where verified |
|---|---|
| Loading | Skeleton on slow owner pages (`data-slow`), drawer loading skeleton |
| Empty | `.empty` frame (portfolio, tables via `table()` default, "Nothing needs your attention") |
| Error / not found | `/nonexistent-page` (404 engraved numeral page), 403 pages for role-limited routes |
| Validation | Quote/contact forms: `aria-invalid`, linked error text, error summary (`tests/public.test.ts`) |
| Success | Flash toasts (dismissible, auto-hide, paused on hover/focus), thank-you pages |
| Unauthorized | Preview gate (staging/preview), sign-in redirect, 403 for disallowed roles |
| Busy | Submit buttons show a spinner and disable (re-enabled for downloads / bfcache) |
| Reduced motion | All transitions instant; hero renders fully (Chromium `reducedMotion: reduce`) |
