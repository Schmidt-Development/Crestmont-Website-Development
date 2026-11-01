# Full-stack starter v1: how to build a website on it

You are building a real business website: a frontend, a backend, a database and administration. The foundation in `src/`, `migrations/` and `scripts/` already works and is tested. Your job is to configure it from the customer's intake, write the pages, extend it where the customer's scope needs more, and prove that everything works.

## 1. Configure the business: `business.config.json`

- **Fill it only from `BRIEF.json`.**
  - Facts the customer did not give are `null` and listed in `missingInformation`; never invent them.
  - Addresses, hours, prices, service areas, licences and reviews are facts.
  - Your own reasonable choices go in `assumptions` (for example, a 30-minute buffer between jobs).
- **Set `configured: true`.**
- **Enable features in `features`.** Each one must be both:
  - something the customer asked for, and
  - included in the package (see `starter.json` → `packages.<id>.capabilities`).

  Requested features outside the package are scope changes. Do not build them; the gates record them for a change order.
- **Services.** Use `id`, `name`, `description`, `priceCents` (whole cents, or `null` with a `priceNote`), `durationMinutes`, `bookable` and `payable`. Prices for payment always come from here or from the admin, never from the browser.
- **Booking** (if enabled): `hours`, `booking` (`slotIntervalMinutes`, `leadTimeMinutes`, `bufferMinutes`, `maxDaysAhead`, `cancellationNoticeHours`, `resources` with `capacity`, `blackoutDates`) and `serviceArea`.
- **Payments** (if enabled): `{ "provider": "stripe", "currency": "usd", "accountOwner": "customer" }`. This is the customer's own Stripe account, never Crestmont's.

## 2. Design and pages: `public/`

- **Brand.** Set the brand in `public/assets/tokens.css`: colors, fonts, radius. Every text/background pair needs a WCAG AA contrast of at least 4.5:1, and the gates measure it.
- **Pages.** Write the pages the brief lists, within the package page limit. Every page must have:
  - `<!doctype html>`, `lang`, the viewport meta, and a unique `<title>` and meta description;
  - canonical and Open Graph tags (Business and above);
  - exactly one `<h1>`, a `<main>`, and the site navigation;
  - `/assets/app.js` loaded with `defer`.
- **Structured data.** Put `LocalBusiness` (or a more specific type) JSON-LD on the home page, using only real facts.
- **Forms.** Use `<form data-api="/api/contact">` (fields: name, email, message, plus a hidden honeypot `<input class="hp-field" name="website" tabindex="-1" autocomplete="off" aria-label="Leave empty">`) and `<form data-api="/api/quotes">` (fields: name, email, phone, postalCode, city, details, serviceId).
  - Every input needs a `<label for>`.
  - Placeholder forms or `href="#"` controls fail acceptance.
- **Booking widget.** Use `<section data-booking>` containing a `<select name="serviceId">`, an `<input type="date" name="date">`, a `<div class="slots">`, a `<form hidden>` with name, email, phone, address and postalCode fields, and a `<div class="status" role="status" tabindex="-1">`. Keep `public/booking/manage.html` and `confirmation.html`, and replace their brand text.
- **No inline scripts or `on…=` handlers**, and no third-party scripts (the Content-Security-Policy blocks them).
- **Images.** Use only licensed images or the customer's own, give every one meaningful `alt` text and `width`/`height`, and keep each under 500 KB.
- **Never fabricate** testimonials, reviews, ratings, certifications, licences, awards, addresses or customer results.

## 3. Extend the backend when the scope needs it

- **Keep the patterns:**
  - validate every input (`src/lib/validate.js`);
  - parameterized SQL only;
  - `rateLimit` on public writes;
  - `idempotent` on writes that create records;
  - `requireSession` plus roles on admin routes;
  - `audit()` for administrative changes;
  - `queueStmt()` for notifications.
- **Schema changes** go in a new `migrations/0002_….sql`. Never edit `0001_foundation.sql`.
- **Customer-requested features the foundation does not cover** (for example a blog) need their own tests in `tests/site/`, tagged `[feature:<intake key>]`, for example `[feature:blog]`.

## 4. Prove it: `npm run check`

This runs gates A–J and writes `.crestmont/quality/gates.json`.

- **Protected files are restored by the runner.** These are `scripts/gates.mjs`, `scripts/lib/*`, `tests/foundation/*` and `migrations/0001_foundation.sql`; changing them has no effect.
- **A skipped test never counts as passing.** Fix the cause instead of skipping.
- **Gate E (integrations) stays `pending_external`** until the runner's approved test-mode operation has verified the customer's own provider account. That is expected; do not fake it.

## 5. What you never do

- Put secrets in the repository, the config, the frontend or logs.
- Use Crestmont's own accounts for the customer's site.
- Add paid plans or subscriptions.
- Mark anything verified without evidence.
- Treat a Stripe redirect as proof of payment.
- Deploy to production.
