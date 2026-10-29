// About page interactive experiences (docs/frontend/ABOUT.md). Content is drawn only from approved sources — the service
// catalogue, the CMS process steps and the CMS about copy — so nothing here adds claims, people, dates or numbers.
// public/assets/services.js adds the interactions (engines "constellation", "journey", "lab"); without JavaScript
// every node, step and explanation is readable as written.
import { html, type SafeHtml } from "../lib/html.ts";
import { SERVICES, serviceBySlug, servicePath } from "../content/services.ts";

interface Node { key: string; label: string; body: string; services: string[]; links: string[]; x: number; y: number }
// Positions are percentages of the constellation stage (centre = your business).
const NODES: Node[] = [
  { key: "design", label: "Design", body: "Structure, visual design and responsive layouts that present your business clearly — new sites, redesigns and focused landing pages.", services: ["website-design-development", "website-redesign", "landing-pages"], links: ["development", "search"], x: 50, y: 10 },
  { key: "development", label: "Development", body: "Websites and web applications built to a written scope: stores, portals, booking systems and custom tools.", services: ["custom-web-applications", "e-commerce-development", "portals", "booking-scheduling"], links: ["design", "integrations", "care"], x: 87, y: 32 },
  { key: "integrations", label: "Integrations", body: "Payments, CRM, email and third-party APIs connected so information moves without retyping.", services: ["payments-subscriptions", "crm-integrations", "email-automation", "api-integrations"], links: ["development", "ai"], x: 84, y: 76 },
  { key: "ai", label: "AI & automation", body: "Assistants, workflow automation and AI voice receptionists — with people approving anything that matters.", services: ["ai-receptionist", "ai-automation"], links: ["integrations", "care"], x: 50, y: 92 },
  { key: "search", label: "Search & measurement", body: "Technical SEO, analytics, Search Console, Business Profile assistance and performance work — measured, never promised.", services: ["technical-seo", "analytics-search-console", "google-business-profile", "performance-optimization"], links: ["design", "care"], x: 14, y: 32 },
  { key: "care", label: "Hosting & care", body: "Optional hosting and maintenance after launch: updates, monitoring and backups, with your domain always registered to you.", services: ["hosting-maintenance"], links: ["development", "ai", "search"], x: 16, y: 76 },
];

export function constellation(): SafeHtml {
  const byKey = new Map(NODES.map((n) => [n.key, n]));
  const pairs = new Set<string>();
  for (const n of NODES) for (const l of n.links) pairs.add([n.key, l].sort().join("|"));
  const first = NODES[0];
  const detail = (n: Node, on: boolean) => html`<div class="cst__detail" data-cst-detail="${n.key}"${on ? html` data-on` : ""}>
<h3 class="cst__h">${n.label}</h3><p>${n.body}</p>
<p class="cst__connects">Works closely with: ${n.links.map((l) => byKey.get(l)!.label).join(" · ")}</p>
<ul class="cst__services">${n.services.map((slug) => { const s = serviceBySlug(slug)!; return html`<li><a href="${servicePath(s)}">${s.name}</a></li>`; })}</ul></div>`;
  return html`<figure class="sv sv--about sv--constellation" data-sv="constellation" id="sv-constellation" aria-labelledby="sv-cst-t">
<figcaption class="sv__head"><span class="sv__tag">Interactive</span><span class="sv__title" id="sv-cst-t">How our capabilities connect</span></figcaption>
<div class="sv__body"><div class="cst" data-node="${first.key}">
<div class="cst__stage">
<svg class="cst__lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
${NODES.map((n) => html`<line class="cst__spoke" data-spoke="${n.key}" x1="50" y1="51" x2="${n.x}" y2="${n.y}"/>`)}
${[...pairs].map((p) => { const [a, b] = p.split("|"); const A = byKey.get(a)!, B = byKey.get(b)!; return html`<line class="cst__link" data-link="${p}" x1="${A.x}" y1="${A.y}" x2="${B.x}" y2="${B.y}"/>`; })}
</svg>
<span class="cst__core" aria-hidden="true"><img src="/assets/brand/crestmont-crest.png" width="84" height="82" alt=""><span>Your business</span></span>
<div class="cst__nodes" role="group" aria-label="Capabilities">${NODES.map((n, i) => html`<button type="button" class="cst__node" data-cst="${n.key}" aria-pressed="${i === 0 ? "true" : "false"}" style="${`--x:${n.x}%;--y:${n.y}%`}"><span>${n.label}</span></button>`)}</div>
</div>
<div class="cst__panel">${NODES.map((n, i) => detail(n, i === 0))}</div>
</div></div>
<p class="sv__hint">Select a capability to see what it covers, which others it works with, and the services behind it. ${SERVICES.length} services, one team.</p>
<p class="visually-hidden" data-sv-live aria-live="polite"></p>
</figure><script src="/assets/services.js" defer></script>`;
}

/** Idea → live website, from the CMS process steps (phases follow the homepage stage controller). */
export function journey(steps: { title: string; body: string }[]): SafeHtml {
  if (!steps.length) return html``;
  const phaseOf = (i: number) => (steps.length === 11 ? (i < 4 ? "Scope" : i < 5 ? "Design" : i < 8 ? "Build" : "Launch") : "");
  return html`<figure class="sv sv--about sv--journey" data-sv="journey" id="sv-journey" aria-labelledby="sv-jr-t">
<figcaption class="sv__head"><span class="sv__tag">Interactive</span><span class="sv__title" id="sv-jr-t">From your idea to a live website</span></figcaption>
<div class="sv__body"><div class="jr" data-step="0" style="--p:0">
<div class="jr__rail"><span class="jr__end jr__end--start">Your idea</span>
<ol class="jr__stops" role="group" aria-label="Project steps">${steps.map((s, i) => html`<li><button type="button" class="jr__stop" data-jr="${i}" aria-pressed="${i === 0 ? "true" : "false"}" aria-label="${`Step ${i + 1} of ${steps.length}: ${s.title}`}"><span class="jr__dot" aria-hidden="true"></span><span class="jr__lbl" aria-hidden="true">${String(i + 1).padStart(2, "0")}</span></button></li>`)}</ol>
<span class="jr__end jr__end--live">Live website</span><span class="jr__fill" aria-hidden="true"></span></div>
<div class="jr__cards">${steps.map((s, i) => html`<article class="jr__card" data-jr-card="${i}"${i === 0 ? html` data-on` : ""}><p class="jr__meta"><span class="jr__n">${String(i + 1).padStart(2, "0")} / ${String(steps.length).padStart(2, "0")}</span>${phaseOf(i) ? html`<span class="jr__phase">${phaseOf(i)}</span>` : ""}</p><h3 class="jr__h">${s.title}</h3><p>${s.body}</p></article>`)}</div>
</div></div>
<div class="sv__controls" role="group" aria-label="Move through the journey"><button type="button" class="sv__opt" data-jr-prev>Previous step</button><button type="button" class="sv__opt sv__opt--gold" data-jr-next>Next step</button></div>
<p class="visually-hidden" data-sv-live aria-live="polite"></p>
</figure><script src="/assets/services.js" defer></script>`;
}

/** Craft & quality lab: a live mini page that demonstrates how we work — every readout is computed, not claimed. */
export function qualityLab(): SafeHtml {
  const tabs: [string, string, SafeHtml, string][] = [
    ["responsive", "Responsive", html`<label class="lab__ctl"><span>Screen width <output data-lab-w>1024px</output></span><input type="range" min="320" max="1280" step="8" value="1024" data-lab-width aria-describedby="lab-note-responsive"></label>`,
      "Layouts are designed for every width. Drag the slider: the navigation folds into a menu and the cards reflow from three columns to one — the same rules your site follows."],
    ["access", "Accessibility", html`<div class="lab__toggles"><button type="button" class="sv__toggle" data-lab-toggle="focus" aria-pressed="false">Show keyboard order</button><button type="button" class="sv__toggle" data-lab-toggle="contrast" aria-pressed="false">Check contrast</button></div><ul class="lab__ratios" data-lab-ratios></ul>`,
      "Every control is reachable in a sensible order by keyboard, and text contrast is checked against WCAG 2.1 AA (4.5:1 for body text). The ratios shown are computed from the colours on screen."],
    ["precision", "Precision", html`<div class="lab__toggles"><button type="button" class="sv__toggle" data-lab-toggle="grid" aria-pressed="false">Show the 8px grid</button></div>`,
      "Spacing and type sit on a shared scale, so every page lines up — and new pages stay consistent with the old ones."],
    ["tokens", "Maintainability", html`<div class="lab__swatches" role="radiogroup" aria-label="Accent colour token">${([["gold", "#d7b56f", "Gold"], ["teal", "#5fb3a8", "Teal"], ["coral", "#e08a6f", "Coral"], ["blue", "#7ea6e0", "Blue"]] as [string, string, string][]).map(([k, c, l], i) => html`<button type="button" role="radio" class="lab__swatch" data-lab-accent="${c}" aria-checked="${i === 0 ? "true" : "false"}" style="${`--c:${c}`}"><span class="visually-hidden">${l}</span></button>`)}</div>`,
      "Design decisions live in a small set of tokens. Change one value and every button, link and highlight updates together — which keeps future changes quick and safe."],
  ];
  const site = html`<div class="lab__site" data-lab-site style="--lab-w:1024px;--lab-accent:#d7b56f">
<div class="lab__nav"><span class="lab__logo" data-f="1">Northfield</span><span class="lab__links"><span data-f="2">Services</span><span data-f="3">About</span><span data-f="4">Contact</span></span><span class="lab__menu" data-f="2">Menu</span></div>
<div class="lab__hero"><p class="lab__h" data-contrast="heading">Kitchens and bathrooms, planned with you</p><p class="lab__p" data-contrast="body">Written estimates and a schedule you approve.</p><span class="lab__btn" data-f="5" data-contrast="button">Book an estimate</span></div>
<div class="lab__cards"><span data-contrast="muted">Kitchens</span><span>Bathrooms</span><span>Repairs</span></div></div>`;
  return html`<figure class="sv sv--about sv--lab" data-sv="lab" id="lab" aria-labelledby="sv-lab-t">
<figcaption class="sv__head"><span class="sv__tag">Illustrative demonstration</span><span class="sv__title" id="sv-lab-t">Craft you can check</span></figcaption>
<div class="sv__body"><div class="lab" data-tab="responsive">
<div class="lab__tabs" role="tablist" aria-label="Quality topics">${tabs.map(([k, l], i) => html`<button type="button" role="tab" class="lab__tab" id="lab-tab-${k}" aria-controls="lab-panel-${k}" aria-selected="${i === 0 ? "true" : "false"}" tabindex="${i === 0 ? "0" : "-1"}" data-lab-tab="${k}">${l}</button>`)}</div>
<div class="lab__grid"><div class="lab__view" data-lab-view>${site}<span class="lab__gridlines" aria-hidden="true"></span></div>
<div class="lab__panels">${tabs.map(([k, l, ctl, note], i) => html`<section class="lab__panel" role="tabpanel" id="lab-panel-${k}" aria-labelledby="lab-tab-${k}"${i === 0 ? html` data-on` : ""}><h3 class="lab__ph">${l}</h3><p id="lab-note-${k}">${note}</p>${ctl}</section>`)}</div></div>
</div></div>
<p class="sv__hint">A fictional business, for illustration. The width, keyboard order, grid and contrast readouts are live.</p>
<p class="visually-hidden" data-sv-live aria-live="polite"></p>
</figure><script src="/assets/services.js" defer></script>`;
}
