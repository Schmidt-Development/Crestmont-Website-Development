// CMS registry (CMS-001, §59): every editable content key, its fields, its repository default,
// and the public page used to preview it. Public pages always fall back to these defaults when
// no revision has been published. Prices are NOT editable here — they come only from
// src/domain/catalog.ts (CMS-003, CAT-007).
import { PACKAGES, MAINTENANCE_PLANS } from "../domain/catalog.ts";
import { DEFAULT_INACTIVITY_POLICY } from "../domain/project.ts";
import { SERVICES } from "./services.ts";

/** "richtext" = long text in the safe markdown subset rendered by src/ui/markdown.ts (plain paragraphs stay valid). */
export type FieldKind = "text" | "textarea" | "items" | "richtext";
export interface FieldDef { name: string; label: string; kind: FieldKind; max: number; hint?: string }
export interface CmsKeyDef {
  key: string;
  label: string;
  group: string;
  fields: FieldDef[];
  defaults: Record<string, string>;
  previewPath: string;
  /** Pricing presentation: drafts need Founder (pricing.change) approval to publish. */
  sensitivePricing?: boolean;
}

const t = (name: string, label: string, max = 200, hint?: string): FieldDef => ({ name, label, kind: "text", max, hint });
const ta = (name: string, label: string, max = 2000, hint?: string): FieldDef => ({ name, label, kind: "textarea", max, hint });
const rt = (name: string, label: string, max = 6000, hint?: string): FieldDef => ({ name, label, kind: "richtext", max, hint });
const items = (name: string, label: string, max = 12000): FieldDef => ({ name, label, kind: "items", max, hint: "One item per block: first line is the title, following lines are the text. Separate items with a blank line." });

/** Parses the "items" field format: blocks separated by blank lines; first line = title. */
export function parseItems(text: string): { title: string; body: string }[] {
  return text.replace(/\r\n/g, "\n").split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean).map((b) => {
    const [title, ...rest] = b.split("\n");
    return { title: title.trim(), body: rest.join(" ").replace(/\s+/g, " ").trim() };
  });
}
export const paragraphs = (text: string): string[] => text.replace(/\r\n/g, "\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
const block = (rows: [string, string][]) => rows.map(([a, b]) => `${a}\n${b}`).join("\n\n");

const P = PACKAGES;
const pol = DEFAULT_INACTIVITY_POLICY;

export const FAQ_DEFAULT = block([
  ["What do the website packages include?", `Starter covers up to ${P.starter.pageLimit} pages with ${P.starter.revisionRounds} revision rounds, Business up to ${P.business.pageLimit} pages with ${P.business.revisionRounds} rounds, and Premium up to ${P.premium.pageLimit} pages within approved scope with ${P.premium.revisionRounds} rounds. The full list for each package is on the pricing and comparison pages.`],
  ["How do payments work?", "Standard packages are paid 100% upfront. Custom projects are billed in three milestones: a 50% deposit, 25% after you approve the design milestone, and 25% before production launch."],
  ["How are revisions counted?", "Each package includes a fixed number of revision rounds, and every round is recorded in your project. Work beyond the included rounds or outside the agreed scope needs an approved change order with its own scope and price."],
  ["Who owns the finished website?", "You receive the agreed intellectual property rights once the project is paid in full, subject to the licence terms of any third-party components such as fonts, images or plugins. Your domain name always remains yours."],
  ["Can I keep my own domain?", "Yes. You can keep your domain with your current registrar and point it at your new site, or use DNS services managed by Crestmont. Either way, the domain stays registered to you."],
  ["What happens before my site goes live?", "Your site launches only after it passes our internal quality checks and you formally approve it. Nothing is published to your live domain without that approval."],
  ["What if my project goes quiet?", `If we are waiting on you, we send reminders after ${pol.remindAfterDays.join(" and ")} days of inactivity and escalate after ${pol.escalateAfterDays} days. A project may then be paused under our disclosed policy. We never cancel a project silently.`],
  ["Can you promise first-page search results?", "No. Nobody can honestly promise rankings, traffic, leads or sales. We build the technical foundations search engines rely on and set up measurement so you can see how the site performs."],
  ["Do you use AI?", "Yes, as an assistant. Package copy is AI-assisted draft copy that you review and approve, and our team uses AI to help draft and summarise. People make every decision about refunds, contracts, pricing and releases."],
  ["How do I get support?", "Customers can submit support tickets at any time from the customer portal. Our staffed support hours are published on the support policy page."],
  ["Do you offer refunds?", "Refund requests are reviewed by our support team and decided by the Founder, except where law or card-network rules require otherwise. See the refund policy for details."],
  ["Do you offer ongoing maintenance?", `Yes. Optional monthly plans — ${Object.values(MAINTENANCE_PLANS).map((m) => m.name).join(", ")} — cover hosting and upkeep after launch. Full plan details are published on the hosting and maintenance page once finalised.`],
]);

const PROCESS_DEFAULT = block([
  ["Enquiry and scope", "Tell us about your business and goals. For standard packages you can purchase directly; for anything larger we review technical feasibility and send a written quote."],
  ["Purchase or accepted quote", "Standard packages are paid upfront. Custom projects begin with a 50% deposit after you accept the quote."],
  ["Onboarding", "You complete an onboarding questionnaire and share content, brand assets and access through your customer portal."],
  ["Scope review", "We confirm pages, features and integrations against your package or quote before design starts."],
  ["Design", "We design the look and structure of your site. Custom projects have a formal design approval milestone."],
  ["Development", "We build the site, its forms and integrations, and configure technical SEO and analytics within scope."],
  ["Internal quality assurance", "Engineering, accessibility, security and performance checks happen before you see a review build."],
  ["Your review and revisions", "You review the site and request changes. Each revision round is counted against your package."],
  ["Final approval", "You formally approve the finished site. Required payments are verified."],
  ["Launch and handoff", "We deploy to your domain and hand over access, documentation, ownership details and training materials for your final acceptance."],
  ["Ongoing care (optional)", "Choose a monthly maintenance plan, or take the site elsewhere. Your domain remains yours."],
]);

const pageSeo: [string, string, string, string][] = [
  ["home", "/", "Crestmont Website Development", "Premium website design and development for businesses across the United States, with published packages, counted revisions and launch only on your approval."],
  ["services", "/services", "Services", "Website design and development, redesigns, e-commerce, custom web applications, portals, integrations, technical SEO and maintenance."],
  ["pricing", "/pricing", "Pricing", "Published fixed-price website packages and custom development quoted separately."],
  ["compare", "/pricing/compare", "Compare packages", "Side-by-side comparison of the Starter, Business and Premium website packages."],
  ["portfolio", "/portfolio", "Portfolio", "Real, live websites in the Crestmont portfolio."],
  ["about", "/about", "About Crestmont", "How Crestmont Website Development works and what we will and will not promise."],
  ["process", "/process", "Development process", "From enquiry to launch and handoff: how a Crestmont project runs."],
  ["quote", "/quote", "Request a custom quote", "Request a written quote for custom development or work beyond the standard packages."],
  ["contact", "/contact", "Contact", "Send Crestmont Website Development a message."],
  ["faq", "/faq", "Frequently asked questions", "Answers about packages, payments, revisions, ownership, support and refunds."],
  ["hosting", "/hosting-maintenance", "Hosting & maintenance", "Optional monthly hosting and maintenance plans after launch."],
];

const serviceKeys: CmsKeyDef[] = SERVICES.filter((s) => s.pricing !== "maintenance").map((s) => ({
  key: `service.${s.slug}`, label: s.name, group: "Service descriptions", previewPath: `/services/${s.slug}`,
  fields: [t("summary", "Summary", 300), rt("intro", "Introduction", 2000)],
  defaults: { summary: s.summary, intro: s.intro },
}));

export const CMS_KEYS: CmsKeyDef[] = [
  { key: "home.hero", label: "Hero", group: "Homepage sections", previewPath: "/",
    fields: [t("eyebrow", "Eyebrow"), t("heading", "Heading"), ta("lede", "Lead paragraph", 600), t("primary_label", "Primary button label", 40), t("quote_label", "Quote button label", 40)],
    defaults: { eyebrow: "Website design & development · United States", heading: "Websites built with discipline and care.", lede: "Crestmont designs and builds websites and web systems for businesses of every size — with published prices, a written scope, counted revisions, and nothing launched until you approve it.", primary_label: "View packages", quote_label: "Request a custom quote" } },
  { key: "home.why", label: "Why Crestmont", group: "Homepage sections", previewPath: "/",
    fields: [t("heading", "Heading"), items("items", "Points")],
    defaults: { heading: "Why Crestmont", items: block([
      ["Published, server-enforced pricing", "Package prices are published and enforced by our systems. Nothing is added to your bill without an approved change order."],
      ["Counted revisions", "Every package states its revision rounds, and every round is recorded in your project."],
      ["Your approval before launch", "Sites go live only after internal quality checks and your formal approval."],
      ["You keep what is yours", "Your domain stays registered to you, and you receive the agreed intellectual property rights after full payment."],
      ["Honest expectations", "We build the technical foundations for search and measurement, and we do not promise rankings, traffic or sales."],
      ["A real portfolio", "Our portfolio shows live websites with genuine screenshots — never mock-ups or stock imagery."],
    ]) } },
  { key: "home.capabilities", label: "Technical capabilities", group: "Homepage sections", previewPath: "/",
    fields: [t("heading", "Heading"), items("items", "Capabilities")],
    defaults: { heading: "Technical capabilities", items: block([
      ["Responsive, accessible front ends", "Layouts that work on phones, tablets and desktops, built toward WCAG 2.1 AA."],
      ["Performance", "Optimised images and assets, minimal scripts and modern edge hosting."],
      ["Security", "Two-factor sign-in for staff, CSRF protection, strict content security policies and audit logging."],
      ["Integrations", "Payments, scheduling, CRM, email and other services connected through their documented APIs."],
      ["Applications and portals", "Role-based customer and staff portals, dashboards and custom workflows."],
      ["Search and measurement", "Technical SEO, Search Console and analytics configured under your ownership."],
    ]) } },
  { key: "home.experience", label: "Customer experience", group: "Homepage sections", previewPath: "/",
    fields: [t("heading", "Heading"), ta("lede", "Lead paragraph", 600), items("items", "Points")],
    defaults: { heading: "A clear customer experience", lede: "Every customer gets a private portal for their project.", items: block([
      ["Project status", "See which stage your project is in and what is waiting on you."],
      ["Approvals and revisions", "Review work, approve milestones and see how many revision rounds remain."],
      ["Files and messages", "Share content and talk to the team in one place, with history kept."],
      ["Billing and support", "View invoices, manage subscriptions and submit support tickets at any time."],
    ]) } },
  { key: "home.cta", label: "Closing call to action", group: "Calls to action", previewPath: "/",
    fields: [t("heading", "Heading"), ta("body", "Text", 600)],
    defaults: { heading: "Ready to talk about your website?", body: "Choose a package, request a custom quote, or send us a message. We reply with straight answers about scope, price and timing." } },
  { key: "services.overview", label: "Services overview", group: "Pages", previewPath: "/services",
    fields: [t("heading", "Heading"), ta("lede", "Lead paragraph", 600)],
    defaults: { heading: "Services", lede: "Everything Crestmont offers, from a five-page website to custom web applications. Standard websites are delivered through published packages; larger work is quoted separately after a feasibility review." } },
  { key: "pricing.presentation", label: "Pricing presentation", group: "Pricing presentation", previewPath: "/pricing", sensitivePricing: true,
    fields: [t("heading", "Heading"), ta("lede", "Lead paragraph", 600), t("starter_tagline", "Starter tagline", 160), t("business_tagline", "Business tagline", 160), t("premium_tagline", "Premium tagline", 160), t("custom_heading", "Custom development heading", 120), ta("custom_body", "Custom development text", 800)],
    defaults: { heading: "Pricing", lede: "Published prices, enforced by our systems. Standard packages are paid upfront; custom work is quoted in writing and billed in milestones.", starter_tagline: "A focused, professional website for a small business.", business_tagline: "More pages, more customisation and defined integrations.", premium_tagline: "Bespoke design and advanced functionality within an approved scope.", custom_heading: "Custom development", custom_body: "Advanced e-commerce, custom SaaS platforms, complex web applications, specialised databases, extensive AI automation, advanced API integrations and work beyond package limits are quoted separately." } },
  { key: "about.page", label: "About Crestmont", group: "Pages", previewPath: "/about",
    fields: [t("heading", "Heading"), ta("lede", "Lead paragraph", 600), rt("body", "Body", 6000)],
    defaults: { heading: "About Crestmont", lede: "Crestmont Website Development designs and builds websites and web systems for businesses across the United States.",
      body: "We work the way established professional firms do: a written scope, published prices, recorded approvals and a clear handoff. You always know what you are buying, what is included, and what happens next.\n\nWe do not publish claims we cannot support. You will not find inflated client counts, invented awards or anonymous testimonials here. Our portfolio shows real, live websites, and our prices are on the pricing page.\n\nWe use AI where it helps — drafting copy for your review, summarising requests, routing enquiries — and people make every decision that matters: scope, price, refunds, contracts and what goes live." } },
  { key: "process.page", label: "Development process", group: "Pages", previewPath: "/process",
    fields: [t("heading", "Heading"), ta("lede", "Lead paragraph", 600), items("steps", "Steps")],
    defaults: { heading: "How a project runs", lede: "Every Crestmont project follows the same disciplined path, tracked in your customer portal.", steps: PROCESS_DEFAULT } },
  { key: "faq.items", label: "FAQs", group: "FAQs", previewPath: "/faq", fields: [items("items", "Questions and answers")], defaults: { items: FAQ_DEFAULT } },
  { key: "contact.page", label: "Contact details", group: "Contact details", previewPath: "/contact",
    fields: [t("heading", "Heading"), ta("lede", "Lead paragraph", 600)],
    defaults: { heading: "Contact Crestmont", lede: "Send us a message and a member of the team will reply by email. For project-specific work, the custom quote form collects the details we need." } },
  { key: "portfolio.intro", label: "Portfolio introduction", group: "Portfolio", previewPath: "/portfolio",
    fields: [t("heading", "Heading"), ta("lede", "Lead paragraph", 800)],
    defaults: { heading: "Portfolio", lede: "Real, live websites. Every screenshot is captured from the production site, and every project links to the site itself." } },
  { key: "hosting.page", label: "Hosting & maintenance", group: "Pages", previewPath: "/hosting-maintenance",
    fields: [t("heading", "Heading"), ta("lede", "Lead paragraph", 800)],
    defaults: { heading: "Hosting & maintenance", lede: "Optional monthly plans to keep your website hosted, updated, monitored and backed up after launch. There are no unlimited development or unlimited support promises — each plan will have explicit, published limits." } },
  ...serviceKeys,
  ...pageSeo.map(([id, path, title, description]): CmsKeyDef => ({
    key: `seo.${id}`, label: `SEO: ${path}`, group: "SEO metadata", previewPath: path,
    fields: [t("title", "Page title", 70), t("description", "Meta description", 170)], defaults: { title, description },
  })),
];

export const cmsKeyDef = (key: string): CmsKeyDef | undefined => CMS_KEYS.find((k) => k.key === key);
