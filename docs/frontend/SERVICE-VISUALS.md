# Interactive service visuals

Every service detail page (`/services/:slug`) and `/hosting-maintenance` has an interactive demonstration to the
right of the unchanged hero copy and CTAs. Below 1000px the layout stacks, with the copy first.

- Markup: `src/ui/service-visuals.ts`. Each visual is complete, readable server HTML.
- Behaviour: `public/assets/services.js`, using event delegation, with no network, storage or forms.
- Styles: `app.css` "Service visuals" and `nojs.css`.

| Page | Visual | What the visitor does |
|---|---|---|
| Website design & development | Layered construction | Select structure / visual design / responsiveness / functionality (isometric separation and explanation); Replay assembles |
| Website redesign | Before/after slider | Drag (mouse or touch), arrow/Home/End/PageUp/PageDown keys, presets; a fictional bakery with the same content on both sides |
| E-commerce development | Shop | Add products and change quantities (integer-cent totals, flat illustrative shipping); illustrative hosted checkout; completion; reset |
| Custom web applications | Connected modules | Book in Scheduling → Dashboard KPIs/feed → Workflow task → Mark done → Dashboard; connection lines pulse |
| Technical SEO | Site map + crawl | Select a page for title/description/canonical/indexing/structured data/links; crawl follows robots → sitemap → links (no rankings) |
| AI chatbots & automation | Staged flow | Inquiry → intake → routing → draft → **human approval gate** (Next is locked until a person approves; request changes) → complete; replay |
| Custom development | Milestone planner | Slider recomputes the 50/25/25 schedule, exact to the cent; "not a quote" |
| Portals | Roles | Customer / staff / administrator re-evaluate seven areas; two-factor requirement; activity log |
| Booking & scheduling | Availability rules | Toggle hours/buffer/same-day/deposit; open-slot count changes; arrow-key grid; confirmation (nothing booked) |
| Payments & subscriptions | Staged flow | Payment type; hosted checkout; signed notification verified; "customer closes the browser" scenario; reconciled |
| API integrations | Staged flow | Encrypted credentials; test event; provider-outage scenario with retries and alert; health table |
| CRM integrations | Staged flow | Field mapping; de-duplication by email; CRM-unavailable scenario |
| Email automation | Staged flow | SPF/DKIM/DMARC toggles change the delivery outcome; bounce suppression |
| Landing pages | Event panel | CTA → form → thanks, recorded events; desktop/phone |
| Search Console & analytics | Event panel | Buttons record named events; ownership stays with the business when access is removed |
| Google Business Profile | Staged flow | Eligibility (online-only is honestly ineligible); profile fields → preview; owner-completed verification |
| Performance optimization | Waterfall | Each optimization changes the bars, the first-content and fully-loaded markers, and layout shift (illustrative, no promised numbers) |
| Hosting & maintenance | Staged flow | Hosting/ownership; updates via staging; outage; backup restore |

## Shared rules

- **Labelling:** every visual carries an "Illustrative demonstration" tag. Businesses are fictional and data is
  synthetic. There are no forms, data inputs (apart from the planner's range control), frames or external URLs.
  `tests/service-visuals.test.ts` enforces this, along with the prohibited-claims and fabrication checks.
- **Without JavaScript:** every layer, step, log and explanation is shown as a list, and the controls are hidden.
  Conditional blocks render their initial-scenario visibility on the server.
- **Input:** mouse, touch and keyboard all work and nothing is hover-only. Buttons expose `aria-pressed` and
  `aria-current`, and the slider is a real `role=slider`. Announcements go through a polite live region per visual.
  Focus is never trapped.
- **Reduced motion:** sequences complete instantly and transitions and animations are off.
- **Offscreen:** timers queue while a visual is offscreen (IntersectionObserver) and CSS animations pause.
- **Layout:** the frame has a fixed layout per breakpoint, with no horizontal overflow at 375, 390, 768 or 1440px.
  Tap targets are at least 34px.
