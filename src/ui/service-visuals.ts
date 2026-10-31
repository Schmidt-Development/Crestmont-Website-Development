// Interactive service visuals (docs/frontend/SERVICE-VISUALS.md). One per service detail page, rendered here as a
// complete, attractive initial state with every explanation readable without JavaScript; public/assets/services.js
// adds the interactions. Everything shown is an illustrative demonstration with fictional businesses and synthetic
// data: no real customers, prices beyond published ones, rankings, traffic or outcomes, and no network calls.
import { html, type SafeHtml } from "../lib/html.ts";
import { receptionistConsole } from "./receptionist.ts";

type Note = { key: string; title: string; body: string };
const opt = (key: string, label: string, pressed = false, extra = "") => html`<button type="button" class="sv__opt" data-key="${key}" aria-pressed="${pressed ? "true" : "false"}"${extra ? html` ${extra}` : ""}>${label}</button>`;
const notes = (list: Note[], live = true) => html`<ol class="sv__notes"${live ? html`` : ""}>${list.map((n, i) => html`<li class="sv__note" data-note="${n.key}"${i === 0 ? html` data-on` : ""}><strong>${n.title}.</strong> ${n.body}</li>`)}</ol>`;

function frame(o: { kind: string; id: string; title: string; body: SafeHtml; controls?: SafeHtml; controlsLabel?: string; notes?: SafeHtml; hint?: string; foot?: SafeHtml }): SafeHtml {
  return html`<figure class="sv sv--${o.kind}" data-sv="${o.kind}" id="sv-${o.id}" aria-labelledby="sv-${o.id}-t">
<figcaption class="sv__head"><span class="sv__tag">Illustrative demonstration</span><span class="sv__title" id="sv-${o.id}-t">${o.title}</span></figcaption>
<div class="sv__body">${o.body}</div>
${o.controls ? html`<div class="sv__controls" role="group" aria-label="${o.controlsLabel ?? "Demonstration controls"}">${o.controls}</div>` : ""}
${o.notes ?? ""}${o.foot ?? ""}
${o.hint ? html`<p class="sv__hint">${o.hint}</p>` : ""}<p class="visually-hidden" data-sv-live aria-live="polite"></p>
</figure><script src="/assets/services.js" defer></script>`;
}

// ── 1. Website design & development: layers assemble into a finished page ──
function layers(): SafeHtml {
  const page = (cls: string, inner: SafeHtml) => html`<div class="sv-layer ${cls}">${inner}</div>`;
  const body = html`<div class="sv-layers" data-view="all"><div class="sv-layers__stack">
${page("sv-layer--structure", html`<span class="sv-layer__label">Structure</span><i class="w w--nav"></i><i class="w w--h"></i><i class="w w--p"></i><i class="w w--btn"></i><i class="w w--img"></i><i class="w w--c1"></i><i class="w w--c2"></i><i class="w w--c3"></i><i class="w w--foot"></i>`)}
${page("sv-layer--visual", html`<span class="sv-layer__label">Visual design</span><b class="v v--logo"></b><b class="v v--h1"></b><b class="v v--h2"></b><b class="v v--p1"></b><b class="v v--p2"></b><b class="v v--img"></b><b class="v v--c1"></b><b class="v v--c2"></b><b class="v v--c3"></b>`)}
${page("sv-layer--responsive", html`<span class="sv-layer__label">Responsiveness</span><span class="r r--desk"></span><span class="r r--tab"></span><span class="r r--phone"></span>`)}
${page("sv-layer--function", html`<span class="sv-layer__label">Functionality</span><span class="f f--form"><i></i><i></i><i class="f__btn"></i></span><span class="f f--ok">✓</span><span class="f f--seo">title · meta · sitemap</span>`)}
</div></div>`;
  return frame({ kind: "layers", id: "layers", title: "From structure to a finished page", body, controlsLabel: "Choose a layer",
    controls: html`${opt("all", "Assembled", true)}${opt("structure", "Structure")}${opt("visual", "Visual design")}${opt("responsive", "Responsiveness")}${opt("function", "Functionality")}<button type="button" class="sv__opt sv__opt--quiet" data-replay>Replay</button>`,
    notes: notes([
      { key: "all", title: "Assembled page", body: "Four layers, planned and reviewed in order, combine into one website. Choose a layer to separate it and see what it contributes." },
      { key: "structure", title: "Structure", body: "Pages and navigation are planned around your services first — what goes where, and how visitors move through the site." },
      { key: "visual", title: "Visual design", body: "Typography, colour, spacing and imagery are applied consistently across every page. Imagery is appropriately licensed or supplied by you." },
      { key: "responsive", title: "Responsiveness", body: "Layouts are built for phones, tablets and desktops, so the same content reads well at every size." },
      { key: "function", title: "Functionality", body: "Contact or enquiry forms within the package scope, technical SEO foundations (titles, descriptions, sitemap) and basic analytics configuration." },
    ]), hint: "Select a layer to pull it out of the page; Replay assembles it again." });
}

// ── 2. Website redesign: draggable before/after of an original fictional site ──
function compare(): SafeHtml {
  const site = (mod: string) => html`<div class="sv-site sv-site--${mod}" aria-hidden="true">
<div class="sv-site__bar"><span class="sv-site__brand">Maple Street Bakery</span><span class="sv-site__nav"><span>Menu</span><span>Order</span><span>Visit</span></span></div>
${mod === "before" ? html`<div class="sv-site__shout">WELCOME TO OUR WEBSITE!!!</div>` : ""}
<div class="sv-site__hero"><span class="sv-site__h">Fresh bread, baked before sunrise</span><span class="sv-site__p">Order ahead online and pick up warm loaves on your way to work.</span><span class="sv-site__cta">Order ahead</span></div>
<div class="sv-site__items"><span>Sourdough</span><span>Croissants</span><span>Rye</span></div>
<div class="sv-site__hours">Open Tuesday–Sunday · 7am–3pm</div></div>`;
  const body = html`<div class="sv-compare" data-pos="50">${site("before")}${site("after")}
<span class="sv-compare__lbl sv-compare__lbl--before">Before</span><span class="sv-compare__lbl sv-compare__lbl--after">After</span>
<div class="sv-compare__handle" role="slider" tabindex="0" aria-label="Compare the original and redesigned layouts" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50" aria-valuetext="Half before, half after"><span class="sv-compare__grip" aria-hidden="true"></span></div></div>`;
  return frame({ kind: "compare", id: "compare", title: "Same content, a clearer site", body, controlsLabel: "Comparison presets",
    controls: html`${opt("0", "Show before")}${opt("50", "Side by side", true)}${opt("100", "Show after")}`,
    notes: html`<ul class="sv__list"><li><strong>Hierarchy.</strong> One headline and one clear call to action instead of competing banners.</li>
<li><strong>Readability.</strong> Higher contrast and a calmer type scale.</li><li><strong>Phones first.</strong> The layout reflows instead of shrinking.</li>
<li><strong>Nothing lost.</strong> Content migrates and changed addresses are redirected: <code>/menu.html → /menu</code>, <code>/order-online.php → /order</code>.</li></ul>`,
    hint: "Drag the handle (or use the arrow keys) to compare. A fictional bakery, created for this illustration — not a client project." });
}

// ── 3. E-commerce: products → cart → illustrative checkout → completion ──
const PRODUCTS = [
  { id: "notebook", name: "Field notebook", cents: 1800 },
  { id: "pen", name: "Brass pen", cents: 4200 },
  { id: "tote", name: "Canvas tote", cents: 2600 },
];
const money = (c: number) => `$${(c / 100).toFixed(2)}`;
function shop(): SafeHtml {
  const body = html`<div class="sv-shop" data-step="products">
<ol class="sv-steps" aria-label="Checkout steps"><li data-step-chip="products" aria-current="step">Products</li><li data-step-chip="cart">Cart</li><li data-step-chip="checkout">Checkout</li><li data-step-chip="done">Complete</li></ol>
<div class="sv-shop__grid">
<ul class="sv-shop__products">${PRODUCTS.map((p) => html`<li class="sv-prod" data-product="${p.id}" data-cents="${p.cents}" data-name="${p.name}"><span class="sv-prod__art sv-prod__art--${p.id}" aria-hidden="true"></span><span class="sv-prod__name">${p.name}</span><span class="sv-prod__price">${money(p.cents)}</span><button type="button" class="sv__opt sv__opt--sm" data-add="${p.id}" aria-label="${`Add to cart: ${p.name}`}">Add to cart</button></li>`)}</ul>
<div class="sv-cart" aria-label="Demonstration cart"><p class="sv-cart__title">Cart <span data-cart-count>(0 items)</span></p>
<ul class="sv-cart__lines" data-cart-lines><li class="sv-cart__empty">Your demonstration cart is empty.</li></ul>
<dl class="sv-cart__sum"><dt>Subtotal</dt><dd data-subtotal>$0.00</dd><dt>Shipping (flat)</dt><dd data-shipping>$0.00</dd><dt>Tax</dt><dd>At checkout</dd><dt class="sv-cart__total">Total before tax</dt><dd class="sv-cart__total" data-total>$0.00</dd></dl>
<button type="button" class="sv__opt sv__opt--gold" data-to-checkout disabled>Continue to checkout</button></div></div>
<div class="sv-shop__checkout" data-panel="checkout"><p class="sv-shop__secure">Secure checkout — hosted by the payment provider</p><p>On a live store, card details are entered on the provider's own secure page and never touch the website. This demonstration collects nothing.</p><p class="sv-shop__amount">Amount due: <strong data-checkout-total>$0.00</strong> + tax</p><div class="sv-shop__actions"><button type="button" class="sv__opt sv__opt--gold" data-pay>Simulate successful payment</button><button type="button" class="sv__opt" data-back-cart>Back to cart</button></div></div>
<div class="sv-shop__done" data-panel="done"><p class="sv-shop__ok">Demonstration order <strong data-order>DEMO-1001</strong> complete</p><p>No order was created and nothing was charged. On a live store, the customer and your team now receive order notification emails.</p><pre class="sv-shop__email" data-email></pre></div>
</div>`;
  return frame({ kind: "shop", id: "shop", title: "Product to cart to checkout", body, controlsLabel: "Shop controls",
    controls: html`<button type="button" class="sv__opt sv__opt--quiet" data-reset>Reset demonstration</button>`,
    hint: "Add sample products and adjust quantities; totals update as you go. A sample store — nothing here collects personal or payment details." });
}

// ── 4. Custom web applications: connected modules with shared data ──
function modules(): SafeHtml {
  const body = html`<div class="sv-mod" data-module="scheduling">
<div class="sv-mod__map" aria-hidden="true"><svg viewBox="0 0 300 200" class="sv-mod__lines"><path class="sv-mod__line" data-line="scheduling" d="M60 50 L150 100"/><path class="sv-mod__line" data-line="dashboard" d="M240 50 L150 100"/><path class="sv-mod__line" data-line="workflow" d="M150 175 L150 100"/></svg>
<span class="sv-mod__node sv-mod__node--core">Shared data</span><span class="sv-mod__node" data-node="scheduling">Scheduling</span><span class="sv-mod__node" data-node="dashboard">Dashboard</span><span class="sv-mod__node" data-node="workflow">Workflow</span></div>
<div class="sv-mod__ui">
<section class="sv-mod__panel" data-panel="scheduling" aria-label="Scheduling module"><p class="sv-mod__h">Thursday · sample appointments</p><ul class="sv-mod__slots">${["9:00", "10:30", "13:00", "14:30", "16:00"].map((t, i) => html`<li><span>${t}</span>${i === 1 ? html`<span class="sv-mod__booked">Booked · R. Alvarez (sample)</span>` : html`<button type="button" class="sv__opt sv__opt--sm" data-book="${t}" aria-label="${`Book ${t}`}">Book</button>`}</li>`)}</ul></section>
<section class="sv-mod__panel" data-panel="dashboard" aria-label="Dashboard module"><p class="sv-mod__h">Today</p><div class="sv-mod__kpis"><span><b data-kpi="bookings">1</b>Bookings</span><span><b data-kpi="open">1</b>Open tasks</span><span><b data-kpi="done">0</b>Completed</span></div><ul class="sv-mod__feed" data-feed><li>9:12 · Appointment booked for 10:30 (sample)</li></ul></section>
<section class="sv-mod__panel" data-panel="workflow" aria-label="Workflow module"><p class="sv-mod__h">Tasks</p><ul class="sv-mod__tasks" data-tasks><li><span>Send confirmation to R. Alvarez</span><button type="button" class="sv__opt sv__opt--sm" data-done>Mark done</button></li></ul></section>
</div></div>`;
  return frame({ kind: "modules", id: "modules", title: "Modules that share one source of truth", body, controlsLabel: "Choose a module",
    controls: html`${opt("scheduling", "Scheduling", true)}${opt("dashboard", "Dashboard")}${opt("workflow", "Workflow")}<button type="button" class="sv__opt sv__opt--quiet" data-reset>Reset</button>`,
    notes: notes([
      { key: "scheduling", title: "Scheduling", body: "Book a sample appointment. The booking is saved once, in shared data — then switch modules to see where it appears." },
      { key: "dashboard", title: "Dashboard", body: "Totals and activity are read from the same shared data, so they are always current without anyone retyping figures." },
      { key: "workflow", title: "Workflow", body: "Each booking creates a follow-up task automatically. Marking it done updates the dashboard straight away." },
    ]), hint: "Book a slot in Scheduling, then open Dashboard and Workflow to follow the information. Sample data only." });
}

// ── 5. Technical SEO: interactive site map with a crawl ──
const SEO_NODES = [
  { id: "home", path: "/", title: "Northfield Renovation — Kitchens & bathrooms in Lansing", desc: "Kitchen and bathroom remodels with written estimates and a project schedule you approve.", canonical: "/", schema: "Organization, WebSite", links: "Out: /services, /about, /contact", index: "index, follow" },
  { id: "services", path: "/services", title: "Remodeling services — Northfield Renovation", desc: "Kitchen and bathroom remodeling services, with what each includes.", canonical: "/services", schema: "BreadcrumbList", links: "In: /, /about · Out: /services/kitchens, /services/bathrooms", index: "index, follow" },
  { id: "kitchens", path: "/services/kitchens", title: "Kitchen remodels — Northfield Renovation", desc: "Cabinets, counters and layouts planned around how you cook.", canonical: "/services/kitchens", schema: "Service, BreadcrumbList", links: "In: /services · Out: /contact", index: "index, follow" },
  { id: "bathrooms", path: "/services/bathrooms", title: "Bathroom remodels — Northfield Renovation", desc: "Showers, tile and storage for small and large bathrooms.", canonical: "/services/bathrooms", schema: "Service, BreadcrumbList", links: "In: /services · Out: /contact", index: "index, follow" },
  { id: "about", path: "/about", title: "About — Northfield Renovation", desc: "Who we are and how a remodel is planned.", canonical: "/about", schema: "BreadcrumbList", links: "In: / · Out: /services", index: "index, follow" },
  { id: "contact", path: "/contact", title: "Contact — Northfield Renovation", desc: "Request an estimate or ask a question.", canonical: "/contact", schema: "ContactPage", links: "In: /, /services/kitchens, /services/bathrooms", index: "index, follow" },
  { id: "old", path: "/old-services.html", title: "Permanent redirect", desc: "An old address from the previous site.", canonical: "→ /services", schema: "—", links: "301 redirect to /services, so links and indexing carry over", index: "redirect" },
  { id: "sitemap", path: "/sitemap.xml", title: "XML sitemap", desc: "Lists the six indexable pages so search engines can discover them.", canonical: "—", schema: "—", links: "Lists: /, /services, /services/kitchens, /services/bathrooms, /about, /contact", index: "file" },
  { id: "robots", path: "/robots.txt", title: "robots.txt", desc: "Allows crawling and points to the sitemap.", canonical: "—", schema: "—", links: "User-agent: * · Allow: / · Sitemap: /sitemap.xml", index: "file" },
];
function sitemap(): SafeHtml {
  const body = html`<div class="sv-seo" data-node="home"><div class="sv-seo__map">
${SEO_NODES.map((n) => html`<button type="button" class="sv-seo__node sv-seo__node--${n.id}${n.index === "file" ? " sv-seo__node--file" : n.index === "redirect" ? " sv-seo__node--redirect" : ""}" data-node-btn="${n.id}" aria-pressed="${n.id === "home" ? "true" : "false"}"><span>${n.path.split("/").map((seg, i) => (i === 0 ? seg : html`/<wbr>${seg}`))}</span></button>`)}
</div>
<div class="sv-seo__inspect">${SEO_NODES.map((n, i) => html`<dl class="sv-seo__meta" data-meta="${n.id}"${i === 0 ? html` data-on` : ""}><dt>Page</dt><dd><code>${n.path}</code></dd><dt>Title</dt><dd>${n.title}</dd><dt>Description</dt><dd>${n.desc}</dd><dt>Canonical</dt><dd><code>${n.canonical}</code></dd><dt>Indexing</dt><dd>${n.index}</dd><dt>Structured data</dt><dd>${n.schema}</dd><dt>Links</dt><dd>${n.links}</dd></dl>`)}</div>
<ol class="sv-seo__log" data-log><li>Select a page, or run a crawl to see how a search engine discovers the site.</li></ol></div>`;
  return frame({ kind: "sitemap", id: "sitemap", title: "How search engines read your site", body, controlsLabel: "Crawl controls",
    controls: html`<button type="button" class="sv__opt sv__opt--gold" data-crawl>Run crawl</button><button type="button" class="sv__opt sv__opt--quiet" data-reset>Reset</button>`,
    hint: "A fictional renovation company and illustrative data. Rankings and traffic depend on factors outside any developer's control and are never promised." });
}

// ── 6+. Generic staged flow (approval gates, toggles and simulated logs) ──
type Stage = { key: string; label: string; body: SafeHtml; gate?: boolean };
function flow(o: { kind: string; id: string; title: string; stages: Stage[]; toggles?: SafeHtml; hint: string; free?: boolean }): SafeHtml {
  const body = html`<div class="sv-flow"${o.free ? html` data-free` : ""} data-stage="${o.stages[0].key}">
<ol class="sv-flow__chips">${o.stages.map((s, i) => html`<li><button type="button" class="sv-flow__chip" data-chip="${s.key}" aria-pressed="${i === 0 ? "true" : "false"}"${s.gate ? html` data-gate` : ""}><span class="sv-flow__n">${String(i + 1).padStart(2, "0")}</span>${s.label}</button></li>`)}</ol>
${o.toggles ? html`<div class="sv-flow__toggles" role="group" aria-label="Scenario">${o.toggles}</div>` : ""}
<div class="sv-flow__panels">${o.stages.map((s, i) => html`<section class="sv-flow__panel" data-panel="${s.key}"${i === 0 ? html` data-on` : ""}${s.gate ? html` data-gate` : ""} aria-label="${s.label}"><h3 class="sv-flow__h"><span class="sv-flow__n">${String(i + 1).padStart(2, "0")}</span> ${s.label}</h3>${s.body}</section>`)}</div></div>`;
  return frame({ kind: `flow sv--${o.kind}`, id: o.id, title: o.title, body, controlsLabel: "Step through the demonstration",
    controls: html`<button type="button" class="sv__opt" data-prev>Back</button><button type="button" class="sv__opt sv__opt--gold" data-next>Next step</button><button type="button" class="sv__opt sv__opt--quiet" data-reset>Replay</button>`,
    hint: o.hint });
}
const log = (id: string, lines: string[], cls = "") => html`<ol class="sv-log${cls ? ` ${cls}` : ""}" data-seq="${id}">${lines.map((l) => html`<li>${l}</li>`)}</ol>`;
const act = (id: string, label: string, gold = true) => html`<button type="button" class="sv__opt${gold ? " sv__opt--gold" : ""}" data-act="${id}">${label}</button>`;
/** Flags that are on in each visual's initial state; conditional blocks render their initial visibility on the server. */
const DEFAULT_ON = new Set(["onetime", "spf", "dkim", "dmarc", "authok", "storefront", "f-name"]);
const when = (flag: string, inner: SafeHtml, not = false) => html`<div ${not ? html`data-unless` : html`data-when`}="${flag}"${DEFAULT_ON.has(flag) === not ? html` hidden` : ""}>${inner}</div>`;
const tog = (flag: string, label: string, on = false) => html`<button type="button" class="sv__toggle" data-toggle="${flag}" aria-pressed="${on ? "true" : "false"}">${label}</button>`;

function aiFlow(): SafeHtml {
  return flow({ kind: "ai", id: "ai", title: "An enquiry, handled with a person in charge", hint: "A synthetic enquiry and a pre-written demonstration draft. No AI model is called and nothing is sent.", stages: [
    { key: "inquiry", label: "Inquiry", body: html`<blockquote class="sv-msg"><p>“Hi — do you install kitchen backsplashes, and could someone visit next week? Budget is flexible.”</p><footer>Sam · website chat · sample enquiry</footer></blockquote>` },
    { key: "intake", label: "Intake", body: html`<dl class="sv-kv"><dt>Topic</dt><dd>Kitchen backsplash installation</dd><dt>Request</dt><dd>Site visit next week</dd><dt>Budget</dt><dd>Not stated — marked for a person to ask</dd><dt>Contact</dt><dd>Sam (sample)</dd></dl><p class="sv-small">Details are organised from the message; anything uncertain is flagged rather than guessed.</p>` },
    { key: "routing", label: "Routing", body: html`<p>Routed to <strong>Estimates</strong> — rule: installation request with a site visit.</p><ul class="sv-route"><li class="is-on">Estimates</li><li>Support</li><li>Billing</li></ul>` },
    { key: "draft", label: "Draft", body: html`<div class="sv-draft"><span class="sv-badge">AI draft — not sent</span><p>Hi Sam, thanks for getting in touch. Yes, we install kitchen backsplashes. We can arrange a visit next week to measure and talk through materials — would Tuesday or Thursday morning suit you?</p></div>` },
    { key: "approval", label: "Human approval", gate: true, body: html`<p>A person reviews the draft before anything leaves the business. Sensitive decisions — prices, refunds and commitments — always stay with people.</p><div class="sv-actions">${act("approve", "Approve draft")}${act("changes", "Request changes", false)}</div>${log("changes", ["Returned to draft with your note: “Mention the tile samples.”"], "sv-log--warn")}${log("approve", ["Approved by a person · draft locked"])}` },
    { key: "done", label: "Complete", body: html`<p class="sv-ok">Simulated: the approved reply would be sent and the enquiry logged with its review.</p><p class="sv-small">Usage is logged for cost visibility. In this demonstration nothing was sent and no model was called.</p>` },
  ] });
}
function payFlow(): SafeHtml {
  return flow({ kind: "pay", id: "pay", title: "Payments confirmed by the provider, not the browser", hint: "Illustrative amounts. No payment provider is contacted.",
    toggles: html`${tog("closed", "Customer closes the browser before returning")}`, stages: [
      { key: "type", label: "Payment type", body: html`<div class="sv-actions" role="group" aria-label="Payment type">${tog("onetime", "One-time payment", true)}${tog("deposit", "Deposit")}${tog("subscription", "Subscription")}</div>${when("subscription", html`<p>Recurring billing: the provider charges each period and offers customers self-service management where available.</p>`)}${when("deposit", html`<p>A deposit secures the booking; the balance is collected later.</p>`)}${when("onetime", html`<p>A single charge for an order or service.</p>`)}` },
      { key: "checkout", label: "Hosted checkout", body: html`<p>The customer pays on the provider's own secure, PCI-compliant page. Card numbers never reach your website or database.</p><div class="sv-actions">${act("paid", "Simulate payment")}</div>${log("paid", ["Customer completed payment on the hosted page (simulated)"])}` },
      { key: "notify", label: "Signed notification", body: html`<p>The provider sends a signed notification to your server. Its signature and amount are checked before anything is marked paid.</p><div class="sv-actions">${act("verify", "Receive notification")}</div>${log("verify", ["Notification received: payment completed", "Signature verified ✓", "Amount matches the order ✓", "Order marked paid"])}${when("closed", html`<p class="sv-note-inline">The browser never came back to the site — the order is still confirmed, because confirmation comes from the signed notification.</p>`)}` },
      { key: "reconcile", label: "Reconciled", body: html`<table class="sv-table"><thead><tr><th>Reference</th><th>Type</th><th>Status</th></tr></thead><tbody><tr><td>DEMO-2207</td><td>${when("subscription", html`Subscription`)}${when("deposit", html`Deposit`)}${when("onetime", html`One-time`)}</td><td>Paid · matched</td></tr></tbody></table><p class="sv-small">Records reconcile against the provider's data; you hold the merchant account and the provider charges its fees.</p>` },
    ] });
}
function emailFlow(): SafeHtml {
  return flow({ kind: "email", id: "email", title: "Email that is authenticated, branded and logged", hint: "Simulated delivery for illustration — no email is sent.",
    toggles: html`${tog("spf", "SPF", true)}${tog("dkim", "DKIM", true)}${tog("dmarc", "DMARC", true)}`, stages: [
      { key: "event", label: "Event", body: html`<p>A website event triggers a message: <strong>Booking confirmed</strong> for sample customer Lee.</p>` },
      { key: "template", label: "Template", body: html`<div class="sv-mail"><p class="sv-mail__from">From: Northfield Renovation &lt;bookings@northfield.example&gt;</p><p class="sv-mail__subj">Your estimate visit is booked</p><p>Hi Lee — we'll see you Thursday at 10:00. Reply to this email if anything changes.</p></div>` },
      { key: "auth", label: "Authentication", body: html`<p>Sending-domain records tell inboxes the message really comes from your domain. Switch them above to see the effect.</p><ul class="sv-auth"><li>SPF ${when("spf", html`<b class="ok">pass</b>`)}${when("spf", html`<b class="bad">missing</b>`, true)}</li><li>DKIM ${when("dkim", html`<b class="ok">pass</b>`)}${when("dkim", html`<b class="bad">missing</b>`, true)}</li><li>DMARC ${when("dmarc", html`<b class="ok">pass</b>`)}${when("dmarc", html`<b class="bad">missing</b>`, true)}</li></ul>` },
      { key: "delivery", label: "Delivery log", body: html`<div class="sv-actions">${act("send", "Send (simulated)")}${act("bounce", "Simulate a bounce", false)}</div><div data-when="authok">${log("send", ["Accepted by the email provider", "Delivered (simulated)"])}</div><div data-unless="authok" hidden>${log("send", ["Accepted by the email provider", "Authentication failing — inbox placement at risk"], "sv-log--warn")}</div>${log("bounce", ["Bounced: mailbox does not exist", "Address suppressed and logged — no further sends"], "sv-log--warn")}` },
    ] });
}
function crmFlow(): SafeHtml {
  return flow({ kind: "crm", id: "crm", title: "Website enquiries, straight into your CRM", hint: "Sample enquiries and a sample CRM. Nothing you do here leaves this page.",
    toggles: html`${tog("down", "CRM unavailable")}`, stages: [
      { key: "form", label: "Form submission", body: html`<dl class="sv-kv"><dt>Name</dt><dd>Avery Lane (sample)</dd><dt>Email</dt><dd>avery@example.com</dd><dt>Message</dt><dd>Quote for a bathroom remodel</dd><dt>Source</dt><dd>Website · contact page</dd></dl><div class="sv-actions">${act("submit1", "Submit sample enquiry")}${act("submit2", "Submit again (same email)", false)}</div>${log("submit1", ["Enquiry received · queued for sync"])}${log("submit2", ["Second enquiry from the same email · queued for sync"])}` },
      { key: "mapping", label: "Field mapping", body: html`<table class="sv-table"><thead><tr><th>Form field</th><th>CRM field</th></tr></thead><tbody><tr><td>Name</td><td>Contact · full name</td></tr><tr><td>Email</td><td>Contact · email (match key)</td></tr><tr><td>Message</td><td>Activity · note</td></tr><tr><td>Source</td><td>Lead source</td></tr></tbody></table>` },
      { key: "dedupe", label: "De-duplication", body: html`<p>Contacts are matched by email, so a repeat enquiry updates the existing contact instead of creating a duplicate.</p><div class="sv-actions">${act("sync", "Sync now")}</div><div data-unless="down">${log("sync", ["Contact matched by email → updated, not duplicated", "Activity added to the timeline"])}</div><div data-when="down" hidden>${log("sync", ["CRM did not respond — sync failed", "Alert sent to your team · retry scheduled"], "sv-log--warn")}</div>` },
      { key: "record", label: "CRM record", body: html`<div class="sv-card"><p class="sv-card__h">Avery Lane</p><p class="sv-small">avery@example.com · Lead source: Website</p><ul class="sv-timeline"><li>Enquiry: quote for a bathroom remodel</li><li>Status: New lead</li></ul></div>` },
    ] });
}
function apiFlow(): SafeHtml {
  return flow({ kind: "api", id: "api", title: "Connected services that recover from failure", hint: "Simulated requests between fictional services — nothing is contacted.",
    toggles: html`${tog("outage", "Simulate a provider outage")}`, stages: [
      { key: "creds", label: "Credentials", body: html`<p>Each service's key is stored as an encrypted secret on the server — never in the website's code — and you own the accounts.</p><dl class="sv-kv"><dt>Scheduling API</dt><dd>key ••••7Q2 · encrypted</dd><dt>Accounting API</dt><dd>key ••••B91 · encrypted</dd></dl>` },
      { key: "request", label: "Request", body: html`<p>A new booking is sent to the accounting service so an invoice draft exists without retyping.</p><div class="sv-actions">${act("send", "Send test event")}</div><div data-unless="outage">${log("send", ["POST /invoices → 201 Created", "Invoice draft linked to booking DEMO-3101"])}</div><div data-when="outage" hidden>${log("send", ["POST /invoices → 503 Service unavailable", "Retry 1 after a short wait → 503", "Retry 2 after a longer wait → 503", "Gave up after 3 attempts · error logged · team alerted"], "sv-log--warn")}</div>` },
      { key: "health", label: "Health log", body: html`<table class="sv-table"><thead><tr><th>Integration</th><th>Status</th></tr></thead><tbody><tr><td>Scheduling</td><td>Healthy</td></tr><tr><td>Accounting</td><td><span data-unless="outage">Healthy</span><span data-when="outage" hidden>Failing — retry queued</span></td></tr><tr><td>Email</td><td>Healthy</td></tr></tbody></table><p class="sv-small">What each integration can do depends on the third-party API; its subscription costs are billed by that provider.</p>` },
    ] });
}
function gbpFlow(): SafeHtml {
  return flow({ kind: "gbp", id: "gbp", title: "A complete, accurate Business Profile", hint: "A fictional business. Google decides eligibility, verification and how profiles are shown.", free: true, stages: [
    { key: "eligibility", label: "Eligibility", body: html`<p>How do customers reach the business?</p><div class="sv-actions" role="group" aria-label="Business type">${tog("storefront", "Customers visit us", true)}${tog("service", "We travel to customers")}${tog("online", "Online only")}</div>${when("online", html`<p class="sv-note-inline">Online-only businesses are not eligible for a Business Profile under Google's guidelines, so we would not create one.</p>`)}${when("online", html`<p class="sv-ok">Eligible under Google's guidelines for local businesses.</p>`, true)}` },
    { key: "details", label: "Profile details", body: html`<div class="sv-gbp"><ul class="sv-check" aria-label="Profile information">${["name|Business name", "category|Category", "hours|Opening hours", "website|Website link", "booking|Booking link"].map((x) => { const [k, l] = x.split("|"); return html`<li>${tog(`f-${k}`, l, k === "name")}</li>`; })}</ul>
<div class="sv-gbp__card" aria-label="Profile preview"><p class="sv-gbp__name">Northfield Renovation</p><p data-when="f-category" hidden>Remodeler · Lansing</p><p data-when="f-hours" hidden>Open today · 8am–5pm</p><p data-when="f-website" class="sv-gbp__link" hidden>Website</p><p data-when="f-booking" class="sv-gbp__link" hidden>Book an estimate</p><p class="sv-small">No reviews are created or managed on your behalf.</p></div></div>` },
    { key: "verify", label: "Verification", body: html`<p>Verification is completed by you, through Google's own process.</p><div class="sv-actions">${act("verified", "Mark as verified by you")}</div>${log("verified", ["Verification completed by the business owner (simulated)"])}` },
  ] });
}
function careFlow(): SafeHtml {
  return flow({ kind: "care", id: "care", title: "Care after launch, in plain view", hint: "An illustrative console. Plan inclusions are listed on this page once finalised; nothing here is a service-level promise.", free: true, stages: [
    { key: "hosting", label: "Hosting", body: html`<dl class="sv-kv"><dt>Website</dt><dd>Online (illustrative)</dd><dt>Domain</dt><dd>Registered to you</dd><dt>DNS</dt><dd>Your registrar, or agency-managed DNS</dd></dl><p class="sv-small">Plans are optional; you can always take the site elsewhere.</p>` },
    { key: "updates", label: "Updates", body: html`<div class="sv-actions">${act("update", "Apply updates")}</div>${log("update", ["Updates applied to a staging copy", "Checks pass on staging", "Published to the live site", "Change recorded"])}` },
    { key: "monitoring", label: "Monitoring", body: html`<div class="sv-actions">${act("outage", "Simulate an outage", false)}</div>${log("outage", ["Site stopped responding", "Alert raised", "Cause found and fixed", "Site responding again · incident recorded"], "sv-log--warn")}` },
    { key: "backups", label: "Backups", body: html`<div class="sv-actions">${act("restore", "Restore a backup")}</div>${log("restore", ["Backup selected", "Restored to a staging copy and checked", "Restored to the live site"])}` },
  ] });
}

// ── Custom development: milestone payment planner ──
function milestones(): SafeHtml {
  const body = html`<div class="sv-ms" data-value="2400000"><label class="sv-ms__label" for="sv-ms-range">Illustrative project value <output data-ms-value>$24,000</output></label>
<input class="sv-ms__range" id="sv-ms-range" type="range" min="5000" max="80000" step="500" value="24000" aria-describedby="sv-ms-note">
<ol class="sv-ms__steps"><li><span>Scope &amp; feasibility review</span><b>Before any commitment</b></li><li><span>Written quote</span><b>You approve the scope</b></li><li class="is-pay"><span>Deposit · 50%</span><b data-ms="50">$12,000.00</b></li><li><span>Design approval</span><b>Milestone you sign off</b></li><li class="is-pay"><span>After design approval · 25%</span><b data-ms="25a">$6,000.00</b></li><li><span>Build &amp; automated tests</span><b>Milestone reviews</b></li><li class="is-pay"><span>Before production launch · 25%</span><b data-ms="25b">$6,000.00</b></li><li><span>Launch &amp; handoff</span><b>Documentation included</b></li></ol>
<p class="sv-small" id="sv-ms-note">Not a quote: custom work is priced in writing after a scope and feasibility review. The payment schedule is always 50% / 25% / 25%.</p></div>`;
  return frame({ kind: "milestones", id: "milestones", title: "How a custom project is staged and paid", body, hint: "Move the slider to see the schedule for an illustrative project value." });
}

// ── Portals: what each role can see ──
const ROWS: { label: string; roles: string[] }[] = [
  { label: "Your invoices", roles: ["customer", "staff", "admin"] }, { label: "Shared project files", roles: ["customer", "staff", "admin"] },
  { label: "Support ticket #214", roles: ["customer", "staff", "admin"] }, { label: "Internal notes", roles: ["staff", "admin"] },
  { label: "Other customers' records", roles: ["staff", "admin"] }, { label: "Team & permission settings", roles: ["admin"] }, { label: "Security audit log", roles: ["admin"] },
];
function roles(): SafeHtml {
  const body = html`<div class="sv-roles" data-role="customer"><div class="sv-roles__signin"><span class="sv-roles__who" data-who>Signed in as a customer (sample)</span><span class="sv-roles__mfa" data-mfa>Two-factor: optional</span></div>
<ul class="sv-roles__rows">${ROWS.map((r) => { const on = r.roles.includes("customer"); return html`<li data-roles="${r.roles.join(" ")}"${on ? "" : html` data-denied`}><span>${r.label}</span><b class="sv-roles__state">${on ? "Visible" : "No access"}</b></li>`; })}</ul>
<ol class="sv-roles__activity" data-activity><li>Signed in · customer view</li></ol></div>`;
  return frame({ kind: "roles", id: "roles", title: "Everyone sees exactly what they should", body, controlsLabel: "Choose a role",
    controls: html`${opt("customer", "Customer", true)}${opt("staff", "Staff")}${opt("admin", "Administrator")}`,
    notes: notes([
      { key: "customer", title: "Customer", body: "Customers see their own invoices, files and requests — never another customer's records." },
      { key: "staff", title: "Staff", body: "Staff work across customers, with two-factor sign-in required, but cannot change team settings." },
      { key: "admin", title: "Administrator", body: "Administrators manage team permissions, and sensitive actions are recorded in an audit log." },
    ]), hint: "Switch roles to compare. Permissions are enforced on the server, not just hidden on screen. Sample records." });
}

// ── Booking & scheduling: availability rules → slots → confirmation ──
function booking(): SafeHtml {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri"], times = ["8:00", "9:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00", "17:00"];
  const busy = new Set(["Mon 10:00", "Tue 14:00", "Wed 9:00", "Thu 11:00", "Thu 15:00", "Fri 13:00"]);
  const body = html`<div class="sv-book"><div class="sv-book__rules" role="group" aria-label="Availability rules">${tog("hours", "Business hours 9–5", true)}${tog("buffer", "Buffer between appointments", true)}${tog("sameday", "Allow same-day bookings")}${tog("deposit", "Require a deposit")}</div>
<div class="sv-book__grid" role="grid" aria-label="Sample week"><div class="sv-book__row sv-book__row--head" role="row"><span role="columnheader"></span>${days.map((d) => html`<span role="columnheader">${d}${d === "Mon" ? html`<small> today</small>` : ""}</span>`)}</div>
${times.map((t) => html`<div class="sv-book__row" role="row"><span class="sv-book__t" role="rowheader">${t}</span>${days.map((d) => html`<span role="gridcell"><button type="button" class="sv-slot" data-day="${d}" data-time="${t}"${busy.has(`${d} ${t}`) ? html` data-busy` : ""} aria-label="${`${d} ${t}`}">${busy.has(`${d} ${t}`) ? "Busy" : ""}</button></span>`)}</div>`)}</div>
<p class="sv-book__count" data-count></p>
<div class="sv-book__confirm" data-confirm><p class="sv-ok">Select an open time to see the confirmation.</p></div></div>`;
  return frame({ kind: "booking", id: "booking", title: "Availability rules that shape every booking", body, hint: "Toggle the rules to change which times are offered, then choose a time. Sample calendar — nothing is booked." });
}

// ── Analytics & Search Console, and landing pages: events you can watch ──
function events(kind: "analytics" | "landing"): SafeHtml {
  const site = kind === "analytics"
    ? html`<div class="sv-ev__site" data-device="desktop"><p class="sv-ev__brand">Northfield Renovation</p><p class="sv-ev__h">Kitchens and bathrooms, planned with you</p><div class="sv-ev__btns"><button type="button" class="sv__opt sv__opt--sm" data-ev="click_call|method: phone link">Call us</button><button type="button" class="sv__opt sv__opt--sm" data-ev="book_estimate|conversion: yes">Book an estimate</button><button type="button" class="sv__opt sv__opt--sm" data-ev="form_submit|form: contact · conversion: yes">Send contact form</button><button type="button" class="sv__opt sv__opt--sm" data-ev="purchase|item: gift card · conversion: yes">Buy a gift card</button></div></div>`
    : html`<div class="sv-ev__site sv-ev__site--landing" data-device="desktop"><p class="sv-ev__brand">Northfield Renovation</p><p class="sv-ev__h">Free in-home kitchen estimate</p><p class="sv-ev__p">One visit, a written estimate and a schedule you approve.</p><button type="button" class="sv__opt sv__opt--gold" data-ev="cta_click|section: hero" data-open-form>Get my estimate</button>
<div class="sv-ev__form" data-form><span class="sv-ev__field">Name</span><span class="sv-ev__field">Email</span><button type="button" class="sv__opt sv__opt--sm" data-ev="generate_lead|form: estimate · conversion: yes" data-submit-form>Submit (demo)</button></div><p class="sv-ok sv-ev__thanks" data-thanks>Thanks — this is where the confirmation appears.</p></div>`;
  const body = html`<div class="sv-ev">${site}<div class="sv-ev__panel"><p class="sv-ev__ph">Events recorded <span class="sv-small">(illustrative)</span></p><ol class="sv-ev__log" data-evlog><li class="sv-ev__empty">Interact with the page to record events.</li></ol>
${kind === "analytics" ? html`<dl class="sv-kv sv-ev__own"><dt>Analytics property owner</dt><dd>Your business</dd><dt>Crestmont</dt><dd data-access>Delegated access</dd><dt>Search Console</dt><dd>Domain verified via DNS record</dd></dl>` : ""}</div></div>`;
  return frame({ kind: `events sv--${kind}`, id: kind, title: kind === "analytics" ? "Measure the actions that matter" : "One offer, one action, measured", body, controlsLabel: kind === "analytics" ? "Ownership" : "Device",
    controls: kind === "analytics" ? html`<button type="button" class="sv__toggle" data-remove-access aria-pressed="false">Remove Crestmont's access</button><button type="button" class="sv__opt sv__opt--quiet" data-reset>Reset</button>` : html`${opt("desktop", "Desktop", true)}${opt("phone", "Phone")}<button type="button" class="sv__opt sv__opt--quiet" data-reset>Reset</button>`,
    hint: kind === "analytics" ? "A fictional site: click its buttons to see which events are recorded. Accounts are created in your name." : "A fictional landing page: try the call to action and switch devices. We build the page; we do not run advertising, and results are never promised." });
}

// ── Performance optimization: an illustrative load waterfall ──
const RES = [
  { id: "html", label: "HTML document", s: 0, d: 10 }, { id: "css", label: "Stylesheet", s: 10, d: 10 }, { id: "font", label: "Web font", s: 12, d: 14 },
  { id: "hero", label: "Hero image (oversized)", s: 12, d: 46 }, { id: "tag", label: "Third-party tag", s: 20, d: 24 }, { id: "app", label: "Page script (render-blocking)", s: 14, d: 22 },
];
function waterfall(): SafeHtml {
  const body = html`<div class="sv-wf"><div class="sv-wf__opts" role="group" aria-label="Optimisations">${tog("img", "Compress and resize images")}${tog("defer", "Defer non-critical scripts")}${tog("tags", "Review third-party tags")}${tog("cache", "Cache static assets")}${tog("space", "Reserve image space")}</div>
<ul class="sv-wf__rows">${RES.map((r) => html`<li class="sv-wf__row" data-res="${r.id}"><span class="sv-wf__label">${r.label}</span><span class="sv-wf__track"><span class="sv-wf__bar" data-s="${r.s}" data-d="${r.d}" style="${`--s:${((r.s / 70) * 100).toFixed(2)};--d:${((r.d / 70) * 100).toFixed(2)}`}"></span></span></li>`)}</ul>
<div class="sv-wf__marks"><span class="sv-wf__mark" data-mark="first">First content visible</span><span class="sv-wf__mark sv-wf__mark--end" data-mark="end">Fully loaded</span></div>
<p class="sv-wf__shift" data-shift>Layout shift: the hero image pushes text down as it loads</p></div>`;
  return frame({ kind: "waterfall", id: "waterfall", title: "What slows a page down — and what fixes it", body, hint: "Toggle each optimisation to see its effect. Illustrative timings, not a measurement of your site: real improvements are measured before and after and reported, never promised in advance." });
}

const VISUALS: Record<string, () => SafeHtml> = {
  "website-design-development": layers, "website-redesign": compare, "e-commerce-development": shop, "custom-web-applications": modules,
  "technical-seo": sitemap, "ai-automation": aiFlow, "custom-development": milestones, portals: roles, "booking-scheduling": booking,
  "payments-subscriptions": payFlow, "api-integrations": apiFlow, "crm-integrations": crmFlow, "email-automation": emailFlow,
  "landing-pages": () => events("landing"), "analytics-search-console": () => events("analytics"), "google-business-profile": gbpFlow,
  "performance-optimization": waterfall, "hosting-maintenance": careFlow, "ai-receptionist": () => receptionistConsole({ id: "rc-page" }),
};
export const SERVICE_VISUAL_SLUGS = Object.keys(VISUALS);
export function serviceVisual(slug: string): SafeHtml | null { const f = VISUALS[slug]; return f ? f() : null; }
