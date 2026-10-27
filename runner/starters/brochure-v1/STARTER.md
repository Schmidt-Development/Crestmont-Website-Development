# Brochure starter v1: conventions for the build agent

This repository started from Crestmont's approved brochure starter. Keep its structure; customize its content and
design.

## Structure

- `public/`: the website. Every `.html` file except `404.html` counts toward the package page limit.
- `public/assets/css/tokens.css`: design tokens (color, type, spacing). Derive them from the customer's brand data.
  Change tokens first and keep component styles in `site.css` referring to tokens.
- `public/assets/css/site.css`: mobile-first layout and components (breakpoints at 40rem and 64rem).
- `public/assets/js/contact.js`: progressive enhancement for the contact form.
- `src/worker.js`: the Worker. It only handles `/api/*`. The contact endpoint is UNCONFIGURED: it validates input
  and answers "not connected yet". Do not fake a successful send and do not add a mail provider.
- `wrangler.jsonc`: static-assets project. Do not add routes, custom domains or a `build` command.
- `scripts/check.mjs`: offline acceptance check (`npm run check -- --package <starter|business|premium>`).

## Rules

- Replace every `STARTER-PLACEHOLDER` (the check fails while any remain), including `robots.txt` and
  `sitemap.xml`. If the customer's domain is unknown, keep `https://example.com` in those two files, remove the
  placeholder comment and record the assumption.
- One `<h1>` per page, a `<main>` landmark, labelled form controls, `alt` on every image (empty `alt=""` only for
  decorative images), visible focus styles, WCAG AA contrast.
- Per page: unique `<title>` (≤ 70 characters) and meta description (50–160 characters). Business and premium also
  need a canonical link and `og:title` / `og:description`; premium needs JSON-LD structured data on the home page.
- Images must come from the customer's files or a clearly licensed source; record the source of each image in
  `.crestmont/agent-report.md`.
- Analytics: leave the "not configured" comment in place unless the brief provides an analytics ID; never invent one.
- Keep the site dependency-free unless a package inclusion requires otherwise.
