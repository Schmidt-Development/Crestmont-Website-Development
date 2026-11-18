# Portfolio explorer: live websites and isolated demos

The portfolio is a horizontal explorer of **real, working websites**. Each project shows, in this order
(`previewState` in `src/services/portfolio.ts`):

1. its **isolated demo** (a separate demo deployment built from a verified revision), where the Owner set one up;
2. otherwise its **real live website**, framed directly, when — and only when — that site's own response headers
   permit this Crestmont origin to frame it (`src/services/embed-check.ts`) — **Mode A**;
3. otherwise, when the site refuses framing, the **real live website through Crestmont's remote browser** — **Mode B**
   (see [Display modes](#display-modes-owner-2026-11-16));
4. otherwise the **genuine screenshot**, labelled "Screenshot", with the Visit live website link — **Mode C**.

Nothing is reverse-proxied, no response header of any site is stripped or rewritten, and no site's framing
restriction is bypassed or weakened: Mode B never puts the site in a frame at all.
`src/ui/portfolio-explorer.ts` renders the explorer and `public/assets/portfolio.js` enhances it. The same component
is used on `/portfolio`, on the homepage work section and, with a single slide, on each `/portfolio/:slug` case study.

## Founder authorization (recorded 2026-10-27)

> "I, Noah Schmidt, founder, confirm: I own all four businesses/websites… authorize their names, logos, public website
> imagery, and demonstrations to appear in Crestmont's portfolio. Our team may claim full credit for developing them.
> Describe them accurately as founder-owned/in-house projects developed by our team."

This is recorded through the existing relationship-evidence fields (`relationship`, `relationship_evidence`,
`relationship_documented_at`) and appended to `audit_logs` (`portfolio.relationship_documented`) by
`scripts/portfolio-setup.ts`. The relationship text is "Founder-owned business — website designed and developed
in-house by the Crestmont team". Do not ask the Founder for this again.

## Automatic native readiness for new websites (Owner, 2026-11-18)

> "When I add a website I own, I should not have to modify its security headers manually … Crestmont should
> automatically use its authorized hosting and repository integrations to make that website native-compatible, verify
> it, and display the actual live production website." … "Do not work around this problem by relabeling remote views
> as native."

**Root cause it fixes.** Until this change, Add → `selectDisplayMode()` turned every site that refused framing into Mode B
(remote browser) automatically, and `publishBlockers()` accepted Mode B as publishable. Nothing ever tried to make a new
site native: the six existing sites became native only through hand-made changes in their own repositories.

**Now (migration 0110, `src/services/native/`).** Every entry created from this release is `native_required`:

1. Staff → Portfolio → Add: enter the address. Step 2 reads the page (name, description) and its framing headers and,
   for a site that refuses framing, asks the connected accounts which one serves it (read-only).
2. Create: the orchestrator (`orchestrator.ts`, one step per call — on create, on **Check again**, and every 15 minutes
   for entries in progress) moves the entry through `checking → preparing → native_verified`, or stops at
   `authorization_required` / `unavailable` with the exact reason and what is needed.
3. Preparation through the authorized connection only (ownership is proven by the provider, never inferred from a URL;
   a repository only when the provider links it):
   - **Cloudflare zone** (the host is in a connected zone and proxied: proxied DNS, Workers custom domain or route, Pages
     custom domain): ONE Response Header Transform Rule owned by Crestmont (stable `ref`) that on the host's exact public
     paths **adds** `Content-Security-Policy: frame-ancestors <Crestmont origins>` (the site's own CSP is untouched) and
     removes `X-Frame-Options`. Other rules in the phase are never sent or changed (per-rule endpoints). If it has no
     effect within 10 minutes it is removed again and recorded — never re-applied in a loop.
   - **Vercel project linked to GitHub**: `vercel.json` `headers` entries for the public paths (structured JSON edit,
     everything else kept), via a pull request in that repository; **Cloudflare Pages linked to GitHub**: Crestmont's
     marked block in `_headers` (detaches `X-Frame-Options` on the public paths, adds the frame-ancestors CSP).
     One branch (`crestmont/native-embedding`) and one PR per repository, updated in place. A production branch that
     requires reviews is **never** merged by Crestmont: the entry shows *Authorization required* with the PR link. An
     unprotected branch is merged once GitHub reports the PR mergeable; the provider deploys it through its own Git
     integration and Crestmont follows that deployment (failed → *unavailable* with the deployment's status).
   - Not attempted (honest *unavailable*): the site's own CSP already sets `frame-ancestors` on public pages (a second
     policy cannot override it); a Vercel/Pages project not linked to GitHub; a Pages build whose `_headers` location is
     unknown; a vercel.json that is not valid JSON or uses legacy `routes`.
   - Public paths are "/" plus the homepage's same-site links that are not sensitive (`standard.ts SENSITIVE_ROUTE`:
     sign-in/up, accounts, owner/staff/admin, dashboards, booking/appointments, quotes/applications, checkout, cart,
     billing, payment, invoices, orders, tokens, the API …). Sensitive pages are never listed, never opened, never
     loaded in a frame.
4. **Verification in a real browser** (`verify.ts`): a fresh Chromium (Browser Run in production, a local Chromium in
   development/CI) opens `/portfolio/native-verify/<10-minute token>` — the live site in exactly the portfolio's
   sandboxed iframe, from this Crestmont origin — and checks *frame* (the browser loaded the live origin), *content*
   (not blank, not stuck), *javascript* (animation frames, uncaught errors), *canvas* (every large 2D/WebGL canvas draws
   pixels; animation recorded), *scroll* (a real wheel gesture), *click* (a real click reaches the site), *mobile* (390 px,
   no sideways overflow), and *protected pages* (the sensitive pages the homepage links to still refuse framing).
   Only then `native_verified`. A browser without WebGL says so instead of failing the site. At most
   `PORTFOLIO_NATIVE_VERIFY_DAILY` (default 10) verifications per day, each well under a minute, only on transitions
   or an explicit re-check — the daily header check stays header-only.
5. Publishing keeps every existing requirement (relationship, link, the owner's recorded consent) and additionally
   needs `native_verified`; no screenshots are needed and none can stand in for it. A new entry is **never** shown
   through the remote browser (the remote-session API refuses it too), a demo or a screenshot; if a published native
   entry's site later stops permitting framing, it is marked *Native embedding unavailable* and visitors are told so.

Existing entries (`native_required = 0`, state `legacy`) — the six published sites and the release pipeline's
display-mode acceptance entries — keep the previous behaviour, including Mode B.

**Connections the Owner creates once** (Worker secrets; not in the database; `wrangler secret put` on the production
Worker): `PORTFOLIO_CLOUDFLARE_TOKEN` (Zone:Read, DNS:Read, Transform Rules:Edit, Workers Scripts:Read, Pages:Read —
optionally limited to accounts listed in `PORTFOLIO_CLOUDFLARE_ACCOUNTS`), `PORTFOLIO_VERCEL_TOKEN`
(+ `PORTFOLIO_VERCEL_TEAM`), `PORTFOLIO_GITHUB_TOKEN` (fine-grained, the website repositories only: Contents RW,
Pull requests RW, Metadata R). Without them every new site that refuses framing stops at *Authorization required*
naming the missing connection.

**What is tested, and how.** `tests/portfolio-native.test.ts` drives the staff flow over HTTP against a hermetic model of
the Cloudflare, Vercel and GitHub APIs (`tests/support/native-world.ts`, whose sites change headers only when the fake
provider has actually applied/deployed the change): Cloudflare zone rule, Vercel + GitHub (unprotected and protected),
Cloudflare Pages + GitHub, and the negatives (no connection, unknown domain, unverified Vercel domain, read-only
repository, CSP conflict, invalid link, failed deployment, rule without effect, PR closed unmerged, failed browser
verification, redirects, daily cap, idempotent re-runs). `tests/portfolio-native-browser.test.ts` runs the same
lifecycle with the REAL verifier in real Chromium (CI job "Portfolio scroll isolation", step "Native onboarding end to
end"), including a WebGL scene, and its negatives (WebGL never draws, blank page after a JavaScript failure, a frame the
browser refuses). The provider adapters have **not** yet been exercised against the live Cloudflare/Vercel/GitHub APIs
of the Owner's accounts: that needs the connections above, and a first real onboarding is the remaining proof.

**Websites Crestmont builds** are native-ready by default: both starters carry the standard in `public/_headers`
(`scripts/lib/embedding.mjs` / `scripts/embedding.mjs`, identical copies) — every page `X-Frame-Options: DENY`; the
built public pages (generated from the .html files; admin, booking/token and error pages excluded) detach it and add
the Crestmont frame-ancestors policy. The gates regenerate the block and fail on a conflicting rule; after a release the
runner checks the live headers (`runner/src/embedding.ts`: homepage permits Crestmont and nobody else; a sensitive page
refuses) and the platform does not record the release as *Live and verified* otherwise.

**Native vs direct, measured** (`scripts/live-native-visual.mjs`, in the read-only acceptance workflow): every published
site opened directly and through Crestmont's native frame in the same Chromium — FCP/LCP, CLS, animation fps, scroll and
click response, canvases drawn and animating — and Lead Haven Collective's 3D Earth specifically (cropped screenshots
of both are kept as evidence).

**Finding (2026-11-18, read-only production run 44417984802): Lead Haven Collective's 3D Earth does not render on the
direct production site either** — in Crestmont's frame and on leadhavencollective.com alike, its 1440×900 canvas stays
empty (WebGL is available in that browser). Chromium reports "An import map is added after module script load was
triggered" and "Failed to resolve module specifier \"three\"". Cause, in the site's own source
(`Schmidt-Development/lead-haven-collective` `public/index.html` at d7d8fdd): six `<link rel="modulepreload">` tags for
three.js (lines 21–28) come before `<script type="importmap">` (line 35); the first modulepreload starts module loading,
so the browser rejects the later import map and the bare `"three"` import cannot resolve. Crestmont's 2026-11-15 change
to that site only touched its headers and the end of `<body>`. The fix belongs in the site's repository (move the
import map above the modulepreload links); it was not changed from here, as no change to a destination site is
authorized by this work.

## Real websites first (Owner, 2026-11-18)

> "Correct Crestmont's portfolio so that all five entries currently using demos or remote viewing display their actual
> production websites, preferably through native iframe embedding like Lead Haven Collective." … "An existing demo must
> never override a compatible live production website."

**Order of preference** (`previewState()` in `src/services/portfolio.ts`; regression test in
`tests/portfolio-live-embed.test.ts`): 1. the real production website in a native frame, when its own headers permit
this site (a successful embedding check, at most 8 days old); 2. the real production website through the remote viewer,
when it refuses framing (Mode B); 3. only then an Owner-verified demo (labelled "Interactive demo — no real
transactions") or the genuine screenshot. Until 2026-11-18 a ready demo was returned before the live check, so the four
demo entries never showed their real sites. The embedding check runs daily (Cron, 11:17 UTC), on every production
release and on demand in the staff editor, so a site that changes its headers switches by itself.

**Framing standard for every website Crestmont builds or controls** (applied 2026-11-18 to Get Every Invoice Paid,
Glassly, Better Lansing Mechanics, Lansing Car Rentals and its mentorship site; Lead Haven Collective since 2026-11-15):

- Public, read-only marketing pages send `Content-Security-Policy: frame-ancestors https://crestmontwebsitedevelopment.com
  https://www.crestmontwebsitedevelopment.com` and no `X-Frame-Options` (it cannot name an allowed origin). Never `*`,
  never another site.
- Every other page — sign-in, sign-up, accounts, owner/admin/staff areas, booking, quotes, checkout, billing, payment,
  token links, the API, error pages — keeps `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- Inside a frame, links to non-framable pages open in a new tab (a capture-phase click handler; for client-side routers
  such as Next.js the click must be intercepted before the router, or the private page would render inside the frame).
- One list of framable pages, shared by the headers and the link handler, and a test that pins both sets of headers.
- Never assume an unrelated third-party website may be framed: the embedding check reads its own headers, and a site
  that refuses framing is shown through the remote viewer or not at all.

Release paths used on 2026-11-18 (each site's own): Vercel (Get Every Invoice Paid PR #1, Glassly PR #15 — merge to
`main`), Cloudflare Workers Builds (Better Lansing Mechanics — hotfix PR #25 to `production`, as its PR #10, so
production received only this change; PR #26 brought the same change to `main`/staging), Cloudflare Pages (mentorship —
PR #4 to its production branch `cloudflare-pages-deployment`), and lansingcarrentals.com (PR #5 to its source branch
`claude/session-2026-10-21`, which builds production automatically — its deployment guide describes a manual
`wrangler deploy`; the branch's earlier, not yet released header styling commit 4e40ff6 went live with it). Lead Haven
Collective keeps its content-only update through Crestmont's release (`tools/client-sites/lead-haven-collective`).

**Layout:** `.pfx__meta` uses bounded columns (`minmax(min(100%, 60%), 1fr) fit-content(24rem)`): the links column
fits its content up to 24rem and long mode labels wrap inside it. An `auto` track had sized itself to the remote-view
label's one-line width and squeezed titles and descriptions into a narrow strip. `live-portfolio-check.mjs` checks the
description keeps ≥ 50% of the row on desktop (≥ 85% when stacked) on every slide, and with `--real all` that every
published project shows its real production domain (native or remote, never a demo or `*.workers.dev`).

**Acceptance of native live websites (2026-11-18, after release `0f2e001`).** The release deployed; its
`verify-live-portfolio` job (run 44262294583) failed 10 checks — five, on desktop and phone — that applied the isolated
demo's contract to the real sites. None was a viewer defect, a broken visitor interaction or a weakened header:

| Site | Failed check | Evidence (production, runner GET + browser) | Category |
|---|---|---|---|
| Get Every Invoice Paid | tap on `/login` must load in the frame | `/login` and `/signup`: `X-Frame-Options: DENY`, `frame-ancestors 'none'`; the tap opens a new tab | intentional restriction |
| Lansing Car Rentals | `/partner/apply` must load in the frame | same headers; opens in a new tab | intentional restriction |
| LCR Mentorship | `/book` must load in the frame | same headers; opens in a new tab | intentional restriction |
| Better Lansing Mechanics | label must follow the page after `/services` | the viewer accepts label updates only from approved demo origins (`portfolio.js` `demoMessage`); a cross-origin live page cannot be observed, so the label stays its host | outdated test assumption |
| Glassly Auto Glass | an in-page link must exist | its production homepage has 0 same-site links and 0 in-page anchors | outdated test assumption |

`scripts/preview-explorer-checks.mjs` (`checkLiveSite`) now checks a native live site as the real site it is: sensitive
routes (`SENSITIVE_ROUTE`) must still refuse framing (a security failure otherwise), and a tap on one never loads in the
frame — answered by a stub with the same refusing headers, so the real sign-in page is never requested; a public page
that permits framing is navigated instead; a one-page site's in-page link moves only the site; a site with neither is
recorded and a real click is shown to reach it; the label stays the host and forged messages — also from the live site
itself — change nothing. The demo branch is unchanged. Regression: `scripts/live-site-nav-check.mjs` (CI, fixture sites,
with a negative control whose framable `/login` must fail). `scripts/live-portfolio-viewports.mjs` adds 1440 / 1280 /
820 / 390 / 320 px to the read-only acceptance workflow.

## Live website showcase (Owner, 2026-11-15)

> "I DO NOT want a traditional screenshot-based portfolio. I want Crestmont Website Development to showcase actual,
> functioning client websites directly inside the Crestmont portfolio." … "FIX LEAD HAVEN COLLECTIVE FIRST — Use the
> existing project record. Project name: Lead Haven Collective. Live URL: https://leadhavencollective.com/. Slug:
> lead-haven-collective. Target URL: https://crestmontwebsitedevelopment.com/portfolio/lead-haven-collective. Get the
> live website embedding working correctly for this project, including any necessary authorized configuration changes
> on the destination website." … "For websites I own and control, configure the necessary production security headers
> to explicitly permit framing by https://crestmontwebsitedevelopment.com, without broadly allowing arbitrary websites
> to embed them."

This written instruction is the owner's authorization for Lead Haven Collective (relationship, link and display
consent), recorded by migration `0108_lead_haven_collective_portfolio.sql` only where those records were missing, never
over a recorded withdrawal. Withdraw it in Staff → Portfolio like any other consent.

**How it works**

- *Staff flow.* Staff → Portfolio → Add a project asks only for the live address. Crestmont loads the page once,
  checks its framing headers for this environment's origin and pre-fills name, slug and description from the page's
  own title and description; the staff member confirms or corrects them (and the industry and verified features). The
  project is created unpublished and its editor shows the live preview at once. Publishing still requires the
  verified link ("The preview shows the correct website"), the documented relationship and the owner's consent.
- *Screenshots* are optional for an entry whose live site is verified embeddable (thumbnails, fallback). A site that
  refuses framing needs genuine desktop and mobile captures — the "Portfolio screenshots" workflow takes them from the
  production site with a real browser (`url` input); never mock-ups.
- *The check* (`checkEmbed`): https only, public host names only, follows https redirects (the final address is the
  one framed), reads `Content-Security-Policy` `frame-ancestors` (every enforced policy must allow the origin; when
  present it decides) or else `X-Frame-Options` (DENY / SAMEORIGIN refuse). It runs on create, on "Check again", daily
  (`portfolio_embeds` in the 11:17 UTC cron) and right after every production release
  (`POST /api/ops/portfolio-embeds`, one-time database challenge). An "allowed" answer counts for 8 days; a site that
  stops permitting framing falls back to its screenshot.
- *The page* adds exactly the verified live origins to its CSP `frame-src`. Live frames use the same sandbox as demos
  (scripts, forms, popups; no top navigation, no device permissions) and are shown when they have loaded; a frame
  that does not load within 20 s shows the screenshot or a branded card with Visit live website. Controls: Desktop /
  Tablet / Mobile (1440 / 820 / 390 CSS px, scaled to fit), Reload, Full screen (browser full screen where offered).
- *Owned client sites* permit framing by exactly `https://crestmontwebsitedevelopment.com` and its `www` host on
  their public pages, and keep `frame-ancestors 'none'` + `X-Frame-Options: DENY` on private pages. For Lead Haven
  Collective the change lives in its own repository (`tools/client-sites/lead-haven-collective/manifest.json` names the
  commit); the production release applies it to the running Worker as a content-only update with
  `scripts/client-site-framing.mjs` (verified, rolled back on mismatch, idempotent).
- *Limitation:* a browser does not tell the framing page whether a cross-origin frame was refused, so the explorer
  relies on the server-side check; that is why it is repeated daily and after every release.

## Display modes (Owner, 2026-11-16)

> "Fix Crestmont Website Development's portfolio system so that new websites can be added and displayed interactively
> without requiring any modifications to the destination websites. We are permanently ending the workflow of
> individually repairing websites' security headers to make them compatible with Crestmont."

Adding a project never requires a change to the destination website. The live check (`checkEmbed`) decides the
display method automatically on Add, on "Check again", daily and after every release, and stores it with the project
(`portfolio_projects.display_mode` / `display_reason`, migration 0109; `selectDisplayMode` in
`src/services/portfolio.ts`):

| Mode | When | What visitors get |
|---|---|---|
| **A — Native interactive embed** (`embed`) | the site's own headers permit framing by this origin | the real site in the explorer's sandboxed iframe (unchanged) |
| **B — Remote interactive browser** (`remote`) | the site refuses framing (`frame-ancestors`, `X-Frame-Options`) but answers publicly, and the remote browser is enabled here | the real live site rendered in an isolated Chromium session that Crestmont controls, streamed into the same explorer; the visitor's clicks, scrolling, keys and touch are relayed to it |
| **C — Unavailable / honest fallback** (`unavailable`) | the site did not answer, returned an error, shows a bot check (Crestmont does not bypass it), or the remote browser is off in this environment | a clear notice, the Visit live website link, and a genuine screenshot labelled "Screenshot" if one exists — never presented as interactive |

Staff see the mode, the reason and Mode B's limitations in the editor's *Live preview* card, and an immediate
interactive preview (Mode B previews run through a 30-minute, single-project preview link because the session API
does not read staff cookies). Publishing requirements are unchanged — verified link, documented relationship and the
owner's explicit consent — except that a Mode B entry, like a Mode A entry, needs no screenshots.

### How Mode B works

```
visitor's browser ──POST /api/portfolio/remote-sessions──▶ Worker: same-origin JSON, published remote project (or preview
        │                                                   link), rate limit, concurrency cap, daily budget → one-time token
        └──WebSocket /api/portfolio/remote-sessions/:id/live──▶ Worker checks the token once ──▶ Durable Object
             (one per session, PortfolioBrowser) ──▶ Cloudflare Browser Run: a fresh headless Chromium, its own browser
             context ──CDP──▶ the real live site
   ◀── JPEG frames (Page.startScreencast) drawn on a <canvas>      ── input (mouse, wheel, touch, keys, nav, device) ──▶
```

- `src/services/remote-browser/session.ts` — the session (shared by production and the local/CI driver): new browser
  context, downloads denied, guard script and request interception installed **before** the first navigation, device
  emulation (1440 / 820 / 390 CSS px; phones and tablets get touch and a mobile user agent that still says
  HeadlessChrome), screencast, bounded and rate-limited input (150 messages/s), idle and time limits, and it always
  disposes of the context and closes the browser.
- `src/services/remote-browser/policy.ts` — every request the page makes is paused and decided: https only; never IP
  literals, internal names or cloud-metadata hosts; only GET/HEAD/OPTIONS (no form posts, writes or uploads);
  top-level navigation stays on the project's own site (and its subdomains) and never opens sign-in, account,
  owner/admin, dashboard, billing, checkout/cart, payment, API, upload or download paths — those get a "Private page" /
  "Submitting is turned off" notice. The guard script disables `window.open`, form submission, password and file
  inputs and download links. Dialogs are dismissed, pop-up windows closed, file pickers intercepted.
- `src/services/remote-browser/admission.ts` — one row per session (`remote_browser_sessions`; the IP only as a salted
  hash), atomic concurrency cap, daily browser-minutes budget, per-visitor rate (6 per 10 minutes), random one-time
  token (SHA-256 stored; must connect within 2 minutes), heartbeats, and cleanup of sessions that stop reporting.
- `src/routes/remote-browser.ts`, `src/durable/portfolio-browser.ts` — the API and the Durable Object.
- `public/assets/portfolio.js` — the viewer: draws only the newest frame, maps pointer/touch coordinates to the remote
  viewport, owns every gesture on the canvas (`touch-action: none`, non-passive handlers), so Crestmont's page never
  scrolls while a visitor scrolls the remote site; Back / Forward / Reload / device buttons; only the active slide holds
  a session, which closes when the visitor moves to another project or hides the page; an ended session keeps its last
  picture, greyed and labelled "no longer live", with **Resume**; a refused one (busy, budget, off, error) shows Mode C
  with **Try again** where it can help.
- Configuration (`wrangler.toml`, staging and production): `browser = { binding = "BROWSER" }`, the `PORTFOLIO_BROWSER`
  Durable Object (SQLite class), and `REMOTE_BROWSER = "on"`, `REMOTE_BROWSER_MAX_CONCURRENT = "3"`,
  `REMOTE_BROWSER_DAILY_MINUTES = "20"` (optional `REMOTE_BROWSER_MAX_SESSION_SECONDS`, default 300, and
  `REMOTE_BROWSER_IDLE_SECONDS`, default 90). Anything but `on`, or a missing binding, turns Mode B off and refused
  sites fall back to Mode C.

### Cost (Cloudflare, Workers Paid — no new subscription or provider)

Browser Run (Browser Rendering) and SQLite Durable Objects are included in the Workers Paid plan Crestmont already has.
Published allowances: **10 browser-hours a month** included, then **$0.09 per browser-hour**; **10 concurrent browsers**
included (monthly average of the daily peak), then **$2.00 per additional concurrent browser**. Durable Objects: 1
million requests and 400,000 GB-s a month included.

| Setting | Monthly use at the cap | Extra cost |
|---|---|---|
| Defaults: 3 concurrent, 20 browser-minutes a day | ≈ 10 browser-hours, ≤ 3 concurrent; DO ≈ 4,600 GB-s | **$0** (inside the allowance) |
| 60 minutes a day | ≈ 30 browser-hours | ≈ $1.80 a month |
| 4 hours a day, 10 concurrent | ≈ 120 browser-hours | ≈ $9.90 a month |

Raising the caps is a configuration change in `wrangler.toml` released through the normal approved deploy; when the
daily budget is used up, visitors get Mode C ("Today's interactive viewing time has been used up") until midnight UTC.
`GET /api/portfolio/remote-sessions/status` reports live sessions and minutes used today.

### What Mode B does not do (stated plainly)

- It is **not** native embedding: visitors see a live video-like picture of a real browser, not the page's own DOM.
  Text is slightly less crisp than native (JPEG frames at device pixel ratio 1), and every interaction has a network
  round trip (typically 50–200 ms); fast animations can drop frames.
- Sign-in, accounts, forms that submit, purchases, uploads, downloads, pop-ups and new windows are turned off by
  design. Browser history inside a session is the site's own pages only.
- Visitors on phones cannot type into the remote site with their on-screen keyboard (there is no local text field to
  focus); taps, scrolling and navigation work. Desktop keyboards work.
- Text selection, copy/paste, the right-click menu, audio, camera, microphone, geolocation and file pickers are not
  relayed.
- WebGL and other GPU features run in headless Chromium with software rendering where the site supports it; heavy 3D
  scenes may be slow.
- Sites behind bot protection that challenges headless browsers are shown in Mode C — the challenge is never bypassed,
  and the browser always identifies itself as HeadlessChrome.
- Sessions last at most 5 minutes and end after 90 s without input (Resume starts a new one); with the default caps at
  most 3 people can use the remote view at the same moment — the 4th is told and can try again.
- Browser coverage of the viewer: verified in Chromium (desktop, and Android / iPhone-sized / tablet emulation with
  touch) in CI and in production acceptance. **Real Safari on iOS/macOS has not been verified by an automated test**;
  the viewer uses only standard APIs Safari supports (`WebSocket`, `createImageBitmap(Blob)`, canvas, pointer and touch
  events), but treat Safari as unverified until it is checked on a device.

### Adding a future website (no website-specific code)

1. Staff → Portfolio → Add a project → enter the address → Continue. The confirmation page says which mode was
   selected and why.
2. Confirm the details → Create project. The editor shows the mode and an immediate interactive preview.
3. Record the verified link, the relationship and the owner's consent → Publish. Nothing changes on the website.

### Verification

- `tests/portfolio-remote-browser.test.ts` — selection rules (the regression guard for the whole system), Add flow for
  `frame-ancestors 'none'`, `X-Frame-Options: DENY`, an allowed site, an unreachable site and a bot check; policy;
  admission; API; session core with a fake browser; `wrangler.toml` wiring.
- `scripts/remote-browser-check.mjs` (CI job *Portfolio display modes + remote browser*) — real Chromium against the
  development server with one local Chromium per session and TEST DATA fixture sites (`scripts/fixtures/remote/`): the
  staff Add flow selects A/B/C automatically; on /portfolio/:slug, /portfolio and the homepage clicks, typing, wheel and
  touch scrolling and navigation reach the real page while Crestmont's page stays still; private routes, third-party
  sites, downloads and form posts are refused; reload, Back, device switching, heavy JS animation and a long page;
  Android / iPhone-sized / tablet viewports; concurrency, cleanup, idle timeout, failure recovery and API refusals.
- Production: `live-portfolio-acceptance.yml` after every release (see *Deployment status*).

### Performance (Owner, 2026-11-16: "MASTER PORTFOLIO PERFORMANCE UPGRADE")

Measured first, on production, with `scripts/portfolio-perf.mjs` (workflow *Portfolio performance*, read-only: one
remote session per device, about 2–3 browser-minutes) against Get Every Invoice Paid in portfolio position #2, from a
GitHub runner and on an emulated 5 Mbit/s visitor connection (Chrome network emulation, which throttles the WebSocket):

| Before the upgrade (production, 2026-11-16) | Fast link | 5 Mbit/s link |
|---|---|---|
| Desktop: start → first picture | 4.2–5.4 s | 4.0 s |
| Desktop: frames while the site only animates | 13 fps, 0.83 MB/s, 41–65 KB/frame | 8.6 fps — the link is full (550 KB/s) |
| Desktop: wheel scroll → visible (median) | 317 ms | **855 ms** (up to 1.0 s); continuous scroll 2.4 s |
| Phone: frames while idle | 60 fps, 1.3–1.4 MB/s | link full |
| Phone: swipe → visible (median) | 169–268 ms | **1.1 s** (up to 1.4 s) |
| Direct visit (no Crestmont) | TTFB 238–305 ms, load 486–565 ms, scroll visible in ~1 ms at 50 fps | |

Root causes (confirmed by measurement, not assumed):

1. **No flow control.** Every screencast frame was acknowledged to Chromium on arrival and forwarded at once, so the
   stream ran at whatever rate Chromium could render and the visitor's link could not refuse it. A site that animates
   all the time (Get Every Invoice Paid does) filled an ordinary connection on its own, and every scroll or click then
   waited behind a queue of stale pictures — the "remote computer over a slow link" feel.
2. **Three pictures rendered per picture shown** once the stream was paced: Chromium counts screencast acknowledgements
   per screencast (not per frame) and keeps three frames in flight; acknowledging every frame let it render far ahead.
   Rendering and encoding are the scarce resource in Browser Run (desktop frames topped out at ~13 fps, phone frames —
   a quarter of the pixels — at 60 fps).
3. **Frames larger than shown.** Desktop frames were captured at the full 1440 px whatever the visitor's canvas size.
4. **Every request paused.** All of the page's requests (images, fonts, styles, scripts) waited for a policy decision in
   the Durable Object, a round trip each, which slowed page loads and in-site navigation.
5. **Start-up spent in sequential round trips**: ~6 database queries before the session is admitted, 3 more before the
   WebSocket opens, ~12 sequential browser setup commands.

What changed (shared code only — every current and future Mode B entry, on the homepage, /portfolio, /portfolio/:slug
and staff previews, gets it; no website is modified):

- `src/services/remote-browser/stream.ts` — **flow control**: the viewer acknowledges each picture it has drawn; a
  bounded number of frames is ever on its way (adaptive, 1–6: it grows while the measured round trip stays near its
  minimum and shrinks as soon as a queue forms — a fixed two capped large desktop frames at ~11 fps on a 170 ms round
  trip); while one cannot be sent only the newest waits (stale ones are dropped, never
  queued) and Chromium is not acknowledged, so it renders no more than it can deliver (its in-flight limit is learned
  if a browser version differs — never below 2 and only after three consistent observations, because a single
  misreading on Browser Run's slower desktop rendering halved the frame rate); **look-ahead**: when Chromium takes longer to deliver a frame than the frame interval
  (measured per session — a full desktop page on Browser Run), it may prepare the next picture while the current one
  travels; **input boost**: input unblocks Chromium at once; **frame-rate caps**: 60 fps while the visitor interacts,
  30 fps otherwise (slow links are protected by the flow control, not by the cap);
  **input queue**: pointer moves and touch moves keep only the newest position, wheel steps add up, clicks and keys
  keep their order, one dispatch at a time (no stale input backlog); native base64 decoding.
- `src/services/remote-browser/session.ts` — frames captured no larger than the viewer's canvas is shown (device
  pixels, up to the device width); JPEG quality 55; setup commands in parallel; statistics to the viewer every 2 s
  (produced / sent / dropped frames, frame round trip, input dispatch time, capture width).
- `src/services/remote-browser/policy.ts` `interceptPatterns()` — only requests that can navigate, write, beacon or open
  a stream are paused (Document, XHR, Fetch, Ping, EventSource, CSPViolationReport, Other — the resource types Chromium
  accepts in a fetch filter, verified against the running browser), plus EVERY request to plain http, private/loopback
  IP ranges, IPv6 literals and internal or reserved names, which the policy refuses as before. Public https images,
  styles, fonts and scripts load without a round trip. A type a browser version does not know is dropped and the call
  repeated; if all else fails every request is paused, as before.
- `public/assets/portfolio.js` — v2 hello (with the canvas's displayed size), frame headers, acknowledgement after each
  drawn picture, newest-frame-only drawing scaled to the device size, wheel steps merged per animation frame, canvas
  position read at most once per frame, one quiet retry of a failed start, the session released when the explorer
  leaves the screen.
- `src/services/remote-browser/admission.ts` / `connect.ts` — admission and the WebSocket claim in fewer, parallel
  database round trips (the claim is one atomic `UPDATE … RETURNING`). Preview links (staff and the release pipeline)
  are rate-limited per link instead of per address; public visitors keep the per-address limit.
- Older cached viewers (no hello) keep the original behaviour until they reload.

Budgets and cost are unchanged: 3 concurrent sessions, 20 browser-minutes a day, inside the Workers Paid allowance.
Bandwidth for an animating site is bounded by the 30 fps idle cap and by what the visitor's link can take (it was
0.83–1.4 MB/s before regardless of the link). Known limit: on 2026-11-16 the 20 browser-minutes were used up by the
day's measurements, release checks and visits, after which visitors saw the honest "today's viewing time has been used
up" fallback until midnight UTC — a published Mode B entry consumes browser time for every visitor who opens it, so the
daily budget may need raising as traffic grows (a cost decision for the Owner, see the cost table above).

First production measurement after the upgrade (release e677127, 2026-11-17 00:01 UTC, same harness and device set):

| Get Every Invoice Paid, slot #2 | Before | After e677127 |
|---|---|---|
| Desktop on 5 Mbit/s: scroll → visible (median) | 855 ms | **330 ms** |
| Android-sized on 5 Mbit/s: swipe → visible | 1,095 ms | **298 ms** |
| Desktop on 5 Mbit/s: continuous scroll | 2.4 s to show | 0.54 s settle |
| Idle bandwidth (desktop / iPhone-sized, fast link) | 831 / 1,301 KB/s | 260 / 303 KB/s |
| Desktop, fast link: idle animation | 13 fps | **5.8 fps (worse)** |
| Desktop, fast link: scroll → visible | 317 ms | **405 ms (worse)** |
| iPhone-sized, fast link: swipe → visible / animation | 169 ms / 60 fps | **322 ms / 15 fps (worse)** |

The backlog on ordinary connections was gone, but on fast links the first version was worse: strict one-render-per-
delivery made Browser Run wait for each desktop frame to arrive before rendering the next (its render-and-transfer time
is far longer than the frame interval), and the 15/30 fps caps throttled fast links that did not need it. The
follow-up (#292) keeps the flow control (newest wins, never a queue) and adds the look-ahead, the input boost
and 60/30 fps caps described above. Its production statistics (release 59175a1) showed two remaining flaws on desktop
only: the limit learning had concluded Chromium allows one frame (it allows three — a misreading of Browser Run's
~60 ms desktop rendering), and two frames in flight were too few for 46 KB frames on a 170 ms round trip. The third
change makes the limit learning safe (≥ 2, three confirmations) and the in-flight bound adaptive. Its reference is
the queue-free round trip, measured by frames that leave onto an idle link and re-measured (briefly one frame at a
time) when no new minimum has been seen for 10 s; the bound grows only while round trips stay within 1.25× + 30 ms of
it and shrinks above 1.5× + 60 ms. (Review before merge found that the first version reset its reference to whatever
round trip it measured every 10 s — on a link that had slowed down, that included the queue, and frame delays crept
back to ~450 ms in simulation; the regression tests now pin a mid-session 5 → 2 Mbit/s drop at ≤ 250 ms median.) Server statistics
sent to the viewer every 2 s: `produced`, `sent`, `dropped`, `inFlight`, `inflightCap`, `minRttMs`, `chromeLimit`,
`produceMs`, `lookAhead`, `rttMedMs`, `bytesSent`, `intervalMs`, `inputMedMs`, `inputMerged`, `castWidth`, `quality`.

Regression protection: `tests/portfolio-remote-stream.test.ts` (a simulated Chromium and viewer: one render per
delivered frame, a bounded number in flight, a slow viewer gets fresh frames, 46 KB desktop frames on a 1 MB/s link at
≥ 12 fps with a 95th-percentile frame delay ≤ 250 ms, a 5 Mbit/s link used without a backlog, no stall, older viewers unchanged, input merging) and
the CI performance gate (`scripts/remote-browser-perf-gate.mjs`, after the functional checks): on a throttled
5 Mbit/s visitor link a scroll on a static page must show within 500 ms, a swipe within 700 ms, a scroll on an
always-animating page within 600 ms (the pre-upgrade code did not show it within 1.6 s), Chromium may render at most
2.2× the frames delivered (one look-ahead frame at most), the frame round trip must stay ≤ 400 ms with ≤ 6 frames in
flight and a learned Chromium limit of at least 2, and idle animation is capped (≤ 32 fps) and within the link. The pre-upgrade code fails this gate on four checks; the upgraded code passes it.

**First picture (2026-11-17, after the #293 release).** The production acceptance failed "rendered at 1440 px" on Get
Every Invoice Paid (40 samples with contrast) and Premium Invoices (0). Recording the first screencast frames of the
real websites after navigation (runner Chromium, the same commands as the session) showed a product defect, not a test
artefact: the viewer turned a slide live on the first frame it drew — Chromium's blank page, then Get Every Invoice
Paid's dark empty page (its `load` event fires ~1 s before its content fades in) or Premium Invoices' black frame
before its first paint. Visitors saw an empty box labelled "Live website". The viewer (`portfolio.js`) now keeps the
slide in its starting state until the picture has content (at least 3% of a 64×36 sample differs from its median
colour), Chromium reports the page's first meaningful paint (`painted` notice from `session.ts`), or 6 s of frames have
been drawn (a deliberately minimal page). The acceptance checks (local `remote-browser-check.mjs`, production
`live-remote-acceptance.mjs`) require content at the moment a slide turns live — at least 2% of the samples differ
(empty pages measured 0–1.1%, real content 10–28%) — on desktop, phones and tablet; the `late-paint` fixture (a dark
page whose content fades in after 1.5 s) fails on the previous viewer and passes on this one. Measured on the real
websites (GitHub runner, development server, the runner's Chromium — no production session): Get Every Invoice Paid
turned live after 2.5 s with 8% content, Premium Invoices after 1.5 s with 11.5%, Lending for Beginners after 2.0 s
with 9.8% (phones 24–32%). The same run showed a reservation whose WebSocket never connected (a staff editor closed
while its preview was starting) holding a viewer for ~55 s; such reservations are now released after 20 s
(`admission.ts`), so three abandoned previews no longer lock out every visitor for a minute.

Remaining limits (stated plainly): the picture is still a stream from a browser in Cloudflare — a scroll or click
needs a network round trip plus one rendered frame, so it cannot match a native site's ~1 ms scroll response; desktop
frame rates are bounded by Browser Run's software rendering of the full 1440 px page (raster happens at full size even
when frames are captured smaller); start-up still includes acquiring a fresh isolated browser (seconds), which is not
shared between visitors for isolation.

## Data model (migration 0038, additive; numbered 0037 on the retired frontend-preview branch)

`portfolio_projects` gains these columns:

- `demo_url`
- `demo_status` (`none` | `ready` | `unavailable`)
- `demo_verified_at` and `demo_verified_by`
- `demo_revision` (`repo@sha`)
- `poster_desktop_asset` and `poster_mobile_asset` (`/assets/portfolio/*.webp`, genuine captures of the demo builds)

Staff → Portfolio → *Interactive demo* edits them (`POST /staff/portfolio/:id/demo`, audit `portfolio.demo_updated`;
changing the URL clears verification). Order, publication and copy use the existing controls. Counts, arrows and
labels are derived from the published records.

A demo is embedded only when **all** of the following hold. Otherwise the explorer shows the genuine poster. Visitors
see a status line only when a demo is normally offered and marked `unavailable`; the internal reasons (origin not
approved in this environment, not yet verified) are shown in Staff → Portfolio only (CREST-GAP-047).

**Production is poster-only** (no `PORTFOLIO_DEMO_ORIGINS`): the explorer then omits the *Reset demo* control and its
hint describes screenshots rather than "click inside".

**Screenshot provenance (CREST-GAP-048).** The bundled posters are captures of each project's isolated demonstration
build with sample data — not of the production sites. Public copy and alt text say so ("demonstration build with
sample data"); an uploaded screenshot (Staff → Portfolio) is described without claiming where it was taken. If posters
are ever recaptured from the live sites, update `portfolio.intro` and the alt text in the same change.

1. `demo_status = ready` with a verification date.
2. Its origin is listed in `PORTFOLIO_DEMO_ORIGINS`. Only https origins qualify, plus loopback http in
   `ENVIRONMENT=development`.
3. It is not the production site's host.

Only pages that render the explorer add those origins to `frame-src`. Crestmont keeps `frame-ancestors 'none'`.

## Repeatable setup

```
node --no-warnings scripts/portfolio-setup.ts --out portfolio.sql --origins "<origins>" --verified slug1,slug2
```

The script emits idempotent upserts with fixed ids, writes each audit row only once, and publishes a project only
when `publishBlockers()` is empty. `.github/workflows/deploy-staging.yml` runs it on every staging deploy (step
*Portfolio projects and their isolated demos*). Before marking a demo as verified, that step checks from the runner
that each demo answers `/__demo/info` with `"demo":true` and that its `frame-ancestors` names the staging origin; the
run summary lists "demo verified for staging" per project. (The retired frontend-preview workflow did the same for
the preview origin.)

## Demo contract (each demo deployment)

- `GET /__demo/info` → `{"demo":true,…}`; `GET /__demo/reset` clears demo cookies and redirects (303) to `/`.
- `Content-Security-Policy: frame-ancestors <approved Crestmont origins>` (from `DEMO_FRAME_ANCESTORS`). No
  `X-Frame-Options`, `X-Robots-Tag: noindex`, cookies `SameSite=None; Secure; Partitioned`.
- `/__demo/embed.js` posts `{source:"crestmont-demo", type:"ready"|"navigate", href}` to each approved parent only.
  The parent accepts messages only from the slide's own demo origin, and shows the frame only after "ready", with a
  20-second fallback.
- External links go through `/__demo/leave`, an explanation page with "open in a new tab"; Turo links never
  silently start a booking.
- Server-side isolation:
  - its own D1 database with synthetic records;
  - production secrets are absent;
  - outbound `fetch` is deny-all except named public APIs (Glassly: NHTSA vPIC);
  - payments run against a simulated provider (BLM uses a signed simulated webhook through the real handler);
  - email is captured to a demo outbox;
  - owner, staff, portal, webhook and cron surfaces return 404;
  - no scheduled triggers or routes.

| Project | Demo worker | Source revision | Branch (pushed and deployed — see *Deployment status* below) |
|---|---|---|---|
| Lansing Car Rentals | lansing-car-rentals-portfolio-demo | lansing-car-rentals@e11bf33 | lansing-car-rentals:crestmont/portfolio-demo-rentals |
| Glassly Auto Glass | glassly-portfolio-demo | glassly@dadad20 | glassly:crestmont/portfolio-demo |
| LCR Mentorship | lcr-mentorship-portfolio-demo | lansing-car-rentals@b3e0b17 | lansing-car-rentals:crestmont/portfolio-demo-mentorship |
| Better Lansing Mechanics | better-lansing-mechanics-portfolio-demo | better-lansing-mechanics@59ccaf4 | better-lansing-mechanics:crestmont/portfolio-demo |

Each branch carries a guarded workflow. It refuses to deploy unless the worker name ends in `portfolio-demo`, there
are no routes or triggers, and the database is the demo database. It then recreates the D1 database, deploys, and
smoke-checks the contract above. Each repository needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets
(scoped to Workers and D1 edit).

## Backend requirements (owned by the backend session)

- Migration 0038 is applied to staging by deploy-staging.yml (consolidation PR). Production receives it only through the Founder-approved production deploy.
- Set `PORTFOLIO_DEMO_ORIGINS` for the backend-owned environments when the demos are approved for them. The value
  is a space-separated list of https origins; unset means posters only.
- Optional: R2 storage on staging/production, if uploaded screenshots should replace the bundled posters.

## Deployment status (2026-10-28, 19:50 ET) — all four demos live and connected

Isolation audit run 40783606013: ISOLATED for every repository (Workers Builds triggers `main`, `production`,
`claude/session-2026-10-21`; Pages previews off; Netlify branch deploys only `claude/session-2026-10-21`, PR previews off).

| Demo | URL | Demo workflow run |
|---|---|---|
| Lansing Car Rentals | https://lansing-car-rentals-portfolio-demo.partners-df4.workers.dev/ | lansing-car-rentals 40785029945 |
| LCR Mentorship | https://lcr-mentorship-portfolio-demo.partners-df4.workers.dev/ | lansing-car-rentals 40785033696 |
| Glassly Auto Glass | https://glassly-portfolio-demo.partners-df4.workers.dev/ | glassly 40785026514 |
| Better Lansing Mechanics | https://better-lansing-mechanics-portfolio-demo.partners-df4.workers.dev/ | better-lansing-mechanics 40785531768 |

Each demo workflow passed its scope guard, isolation, framing and blocked-route smoke checks. *Historical (retired
preview origin):* frontend preview run
40787390976 (commit 98ba751) verified each demo from the runner, connected all four, and passed 256/256 hosted
browser checks, including every demo's scroll containment, navigation, reset, device controls and simulated transaction.

**Staging (2026-10-29):** live checks showed that all four demos already list the staging origin
`https://crestmont-platform-staging.partners-df4.workers.dev` in `frame-ancestors`, so staging can embed them (blocker
B1 in [`docs/CONSOLIDATION.md`](../CONSOLIDATION.md) is resolved). Current verification is the staging deploy's
*Portfolio projects and their isolated demos* step (run summary: "demo verified for staging") and *Frontend browser
verification on staging*.

Demo token scope guard: listing zones is not evidence of zone permissions — the token (Account › Workers Scripts ›
Edit, Account › D1 › Edit) sees zone metadata, but every zone surface (settings, DNS, Workers routes, rulesets, page
rules, SSL) answers 403. The guard fails on any readable zone surface, more than one account, or unusable Workers/D1.
