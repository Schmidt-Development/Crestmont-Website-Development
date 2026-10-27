// Policy drafts for attorney review (LEGAL-001, LEGAL-002, WEB-008). These are DRAFTS: every page
// renders a visible "Draft — pending attorney review" banner and nothing here claims attorney
// approval (LEGAL-004 stays open until a real review is recorded).
// Facts that are not yet established (legal entity, registered address, staffed hours) are passed
// in from business_settings and are never invented.
import { PACKAGES, MAINTENANCE_PLANS } from "../domain/catalog.ts";
import { DEFAULT_INACTIVITY_POLICY } from "../domain/project.ts";

export interface LegalSection { heading: string; paras?: string[]; list?: string[] }
export interface LegalDoc { slug: string; title: string; summary: string; sections: LegalSection[] }

export interface LegalFacts {
  legalName: string | null;
  address: string | null;
  staffedHours: string | null;
  supportEmail: string;
  legalEmail: string;
  billingEmail: string;
}

export const LEGAL_SLUGS = ["privacy", "terms", "development-agreement", "refunds", "cancellation", "support", "acceptable-use", "accessibility", "disclosures"] as const;
export type LegalSlug = (typeof LEGAL_SLUGS)[number];

export const DRAFT_BANNER = "Draft — pending attorney review. This document is a working draft published for transparency; it has not yet been reviewed by an attorney and may change before Crestmont accepts payments.";

export function legalDocs(f: LegalFacts): Record<LegalSlug, LegalDoc> {
  const who = f.legalName ?? "Crestmont Website Development (legal entity to be confirmed)";
  const hours = f.staffedHours
    ? `Staffed support hours: ${f.staffedHours}.`
    : "Staffed support hours will be published on this page before Crestmont accepts customer projects.";
  const pol = DEFAULT_INACTIVITY_POLICY;
  return {
    privacy: {
      slug: "privacy", title: "Privacy policy", summary: "What personal information Crestmont collects, why, and the choices you have.",
      sections: [
        { heading: "Who we are", paras: [`This policy describes how ${who} ("Crestmont", "we") handles personal information collected through crestmontwebsitedevelopment.com, the customer portal and our services. Questions can be sent to ${f.legalEmail}.`] },
        { heading: "Information we collect", list: [
          "Information you give us: your name, email address, phone number, business name, website address and the content of messages, quote requests and support tickets.",
          "Account information: login email, hashed password, two-factor authentication settings and session records.",
          "Project information: files, content, approvals, messages and revision history you share in the customer portal.",
          "Payment information: processed by our payment provider. We receive confirmation of payments and limited card details (such as card brand and last four digits); we do not store full card numbers.",
          "Technical information: IP address, browser type and security logs used to protect accounts and prevent abuse.",
        ] },
        { heading: "How we use information", list: [
          "To respond to enquiries and prepare quotes.",
          "To deliver, support and bill for the services you purchase.",
          "To secure accounts, prevent fraud and investigate abuse.",
          "To send transactional emails about your account, projects, invoices and support tickets.",
          "To meet legal, tax and accounting obligations.",
        ] },
        { heading: "AI-assisted processing", paras: ["We use AI tools to help draft content, summarise requests and route enquiries. People review AI output before it is used for decisions that affect you, and AI is never used to approve refunds, contracts, pricing or releases."] },
        { heading: "Service providers", paras: ["We share information only with providers that help us operate — for example hosting, email delivery, payment processing and AI model providers — under terms that limit their use of the data to providing services to us. We do not sell personal information."] },
        { heading: "Cookies", paras: ["We use strictly necessary cookies for sign-in sessions, security (CSRF protection) and short-lived notices. If we add analytics or other optional cookies, this policy will be updated and any required consent will be requested."] },
        { heading: "Retention", paras: ["We keep account, project and billing records for as long as needed to provide services and meet legal and accounting requirements, and security logs for a limited period. Enquiries that do not become projects are deleted or anonymised after a reasonable period."] },
        { heading: "Your choices and rights", paras: [`Depending on where you live, you may have rights to access, correct, delete or obtain a copy of your personal information, and to opt out of certain processing. Send requests to ${f.legalEmail}. We will verify your identity before acting on a request and will not discriminate against you for exercising your rights.`] },
        { heading: "Security", paras: ["We use encryption in transit, hashed passwords, two-factor authentication for staff, role-based access and audit logging. No system is perfectly secure; we will notify affected people of security incidents as required by law."] },
        { heading: "Children", paras: ["Our services are intended for businesses and are not directed to children under 13."] },
        { heading: "Changes", paras: ["We will post updates on this page and note the effective date. Material changes will be communicated to account holders by email."] },
      ],
    },
    terms: {
      slug: "terms", title: "Terms of service", summary: "The terms that govern use of the Crestmont website, customer portal and services.",
      sections: [
        { heading: "Agreement", paras: [`These terms are between you and ${who}. By creating an account, purchasing a package or accepting a quote, you agree to these terms and to the policies linked from them. Project-specific terms in an accepted quote or development agreement take precedence where they conflict.`] },
        { heading: "Accounts", paras: ["You are responsible for keeping your login credentials secure and for activity under your account. Staff accounts require two-factor authentication; we encourage customers to enable it too. Tell us promptly about any unauthorised use."] },
        { heading: "Services and scope", paras: ["Each package or quote defines the scope of work, including page limits and revision rounds. Work outside that scope requires an approved change order with its own scope and price. We do not expand scope automatically."] },
        { heading: "Prices and payment", paras: [`Package prices are published on our pricing page: Starter ${usd(PACKAGES.starter.basePriceCents)}, Business ${usd(PACKAGES.business.basePriceCents)}, and Premium from ${usd(PACKAGES.premium.basePriceCents)}. Standard packages are paid 100% upfront. Custom projects are billed 50% as a deposit, 25% after the approved design milestone and 25% before production launch. Payments are processed by our payment provider.`] },
        { heading: "Your responsibilities", list: ["Provide accurate information, content and timely feedback.", "Have the rights to all content, trademarks and materials you give us.", "Comply with our acceptable use policy."] },
        { heading: "Intellectual property", paras: ["After full payment you receive the intellectual property rights agreed for your project, subject to the licence terms of third-party components such as fonts, images, plugins and hosted services. Your domain names remain registered to you. We may retain general know-how and reusable tools that are not specific to your project."] },
        { heading: "Launch approval", paras: ["We launch customer websites only after internal quality certification and your approval. We do not launch on your behalf without that approval."] },
        { heading: "No guaranteed outcomes", paras: ["We do not guarantee search rankings, traffic, leads, sales or other business results. Third-party platforms (search engines, payment providers, hosting providers, AI providers) are outside our control."] },
        { heading: "Refunds and cancellation", paras: ["Refunds and cancellations are handled under our refund policy and cancellation policy."] },
        { heading: "Limitation of liability", paras: ["To the extent permitted by law, our total liability for any claim relating to the services is limited to the amounts you paid for the services giving rise to the claim, and we are not liable for indirect or consequential losses. Nothing in these terms limits liability that cannot be limited by law."] },
        { heading: "Changes and contact", paras: [`We may update these terms by posting a new version. Questions: ${f.legalEmail}.`] },
      ],
    },
    "development-agreement": {
      slug: "development-agreement", title: "Development agreement information", summary: "What the development agreement for each project covers, before you sign anything.",
      sections: [
        { heading: "Purpose", paras: ["Every project is governed by a development agreement (for standard packages, the package terms accepted at checkout; for custom work, the accepted written quote). This page summarises what those agreements cover so you know what to expect. It is a summary, not the agreement itself."] },
        { heading: "What the agreement defines", list: [
          "The package or quoted scope, including page counts, features and integrations.",
          "Revision rounds: " + Object.values(PACKAGES).map((p) => `${p.name} ${p.revisionRounds}`).join(", ") + ". Every round is counted.",
          "The payment schedule (100% upfront for packages; 50% / 25% / 25% for custom work).",
          "Your responsibilities for content, feedback and access.",
          "Change orders: additional work requires a written scope, price and approval, and payment where required.",
          "Inactivity: reminders after " + pol.remindAfterDays.join(" and ") + " days without a response, escalation after " + pol.escalateAfterDays + " days, and a possible pause after " + pol.pauseAfterDays + " days. Projects are never cancelled silently.",
          "Launch: internal quality certification plus your approval, and payment verification where required.",
          "Handoff: access, documentation, ownership details, training materials and your final acceptance.",
          "Intellectual property transfer after full payment, subject to third-party licences.",
        ] },
        { heading: "Binding contracts", paras: ["Crestmont will not enter binding customer contracts until its legal identity, required disclosures and agreements are finalised. Agreement acceptance is recorded with the version you accepted."] },
      ],
    },
    refunds: {
      slug: "refunds", title: "Refund policy", summary: "How refund requests are submitted, reviewed and decided.",
      sections: [
        { heading: "How to request a refund", paras: ["Submit a refund request from your customer portal (Billing) or by opening a support ticket. Include the reason and any supporting information."] },
        { heading: "Review and decision", list: [
          "Our support team reviews and documents every request, including the work delivered and the project's history.",
          "Discretionary refunds are decided by the Founder of Crestmont. AI systems never approve or issue refunds.",
          "We tell you the decision in writing and, if a refund is approved, issue it to the original payment method through our payment provider.",
        ] },
        { heading: "What is generally considered", list: ["Work completed and approved before the request.", "Third-party costs already incurred on your behalf (such as licences or domain fees), which are usually non-refundable.", "Whether the work delivered matched the agreed scope."] },
        { heading: "Your legal rights", paras: ["This policy does not limit any refund rights you have under applicable law or payment-card network rules. Where those rules require a refund or a particular process, we follow them regardless of this internal workflow."] },
        { heading: "Contact", paras: [`Billing questions: ${f.billingEmail}.`] },
      ],
    },
    cancellation: {
      slug: "cancellation", title: "Cancellation policy", summary: "Cancelling a project or a maintenance plan.",
      sections: [
        { heading: "Website projects", paras: ["You may ask to cancel a project at any time through your customer portal or a support ticket. Cancellation is confirmed by a person, never automatically. Any refund is handled under the refund policy, taking into account work already completed and approved."] },
        { heading: "Paused projects", paras: [`If a project is inactive because we are waiting on you, we send reminders after ${pol.remindAfterDays.join(" and ")} days, escalate after ${pol.escalateAfterDays} days and may pause the project after ${pol.pauseAfterDays} days. Paused projects can be restarted; they are not cancelled without notice.`] },
        { heading: "Maintenance plans", paras: [`Monthly maintenance plans (${Object.values(MAINTENANCE_PLANS).map((m) => m.name).join(", ")}) renew automatically each month. You can cancel from the billing section of your customer portal; cancellation takes effect at the end of the current billing period, and the current month is not prorated unless required by law.`] },
        { heading: "Your website after cancellation", paras: ["Your domain remains yours. Materials you have paid for in full are handed over in line with the development agreement."] },
      ],
    },
    support: {
      slug: "support", title: "Support policy", summary: "How to get help, and when our team is available.",
      sections: [
        { heading: "Submitting a ticket", paras: ["Customers can submit support tickets at any time, day or night, from the customer portal. You will receive an email confirmation with a ticket reference."] },
        { heading: "Staffed hours", paras: [hours, "Tickets submitted outside staffed hours are queued and answered when the team is next available. Automated acknowledgements are sent at any time; they are not a substitute for a staff response."] },
        { heading: "Response targets", paras: ["Response targets for maintenance plan customers will be published with the finalised plan details. Targets are goals for an initial response, not guarantees of resolution time."] },
        { heading: "What support covers", list: ["Questions about your project, portal, invoices and account.", "Reporting defects in work we delivered.", "Requests for changes, which may require a change order or maintenance-plan time."] },
        { heading: "AI assistance", paras: ["We may use AI to draft replies and summarise tickets. Sensitive replies are reviewed by a person before sending."] },
        { heading: "Contact", paras: [`Email: ${f.supportEmail}.`] },
      ],
    },
    "acceptable-use": {
      slug: "acceptable-use", title: "Acceptable use policy", summary: "Uses of Crestmont-built or Crestmont-hosted services that are not permitted.",
      sections: [
        { heading: "Not permitted", list: [
          "Illegal content or activity, including infringement of others' intellectual property.",
          "Malware, phishing, credential harvesting or deceptive sites.",
          "Unsolicited bulk email or messaging in breach of applicable law.",
          "Content that harasses, threatens or exploits others, including any material exploiting minors.",
          "Attempts to probe, scan or break the security of our systems or other customers' systems.",
          "Using services in a way that degrades them for other customers.",
        ] },
        { heading: "Enforcement", paras: ["We may decline work, suspend hosting or remove content that breaches this policy, after notice where practical. Serious or unlawful breaches may be reported to the relevant authorities."] },
        { heading: "Reporting", paras: [`Report abuse to ${f.legalEmail}.`] },
      ],
    },
    accessibility: {
      slug: "accessibility", title: "Accessibility statement", summary: "Our accessibility commitments and how to report a barrier.",
      sections: [
        { heading: "Our goal", paras: ["We aim for this website and our customer portal to conform with the Web Content Accessibility Guidelines (WCAG) 2.1 at level AA. We have not yet completed an independent accessibility audit, so we do not claim full conformance."] },
        { heading: "What we do", list: ["Semantic HTML with headings, landmarks and a skip link.", "Keyboard-operable navigation, forms and dialogs with visible focus.", "Form errors announced to assistive technology and linked to their fields.", "Colour contrast checked against WCAG AA for text.", "Respect for reduced-motion preferences.", "All features work without JavaScript."] },
        { heading: "Known limitations", paras: ["Some third-party services we link to (such as payment pages) are operated by others and may have their own accessibility limitations."] },
        { heading: "Feedback", paras: [`If you encounter a barrier, email ${f.supportEmail} or use the contact form. Tell us the page and the problem, and we will respond and work on a fix or an alternative way to get what you need.`] },
      ],
    },
    disclosures: {
      slug: "disclosures", title: "Business disclosures", summary: "Who operates this website and how to reach us.",
      sections: [
        { heading: "Business identity", paras: [
          f.legalName ? `Legal name: ${f.legalName}.` : "The legal entity that operates Crestmont Website Development is being established. Its legal name will be published here before Crestmont accepts payments or enters binding customer contracts.",
          f.address ? `Registered business address: ${f.address}.` : "A registered business mailing address will be published here before Crestmont accepts payments.",
        ] },
        { heading: "Trading name", paras: ["Crestmont Website Development."] },
        { heading: "Contact", list: [`Support: ${f.supportEmail}`, `Billing: ${f.billingEmail}`, `Legal: ${f.legalEmail}`] },
        { heading: "Payments", paras: ["Online payments are processed by a third-party payment provider. Crestmont does not store full card numbers."] },
        { heading: "Policies", paras: ["Our privacy policy, terms of service, refund, cancellation, support and acceptable use policies are linked below. They are drafts pending attorney review."] },
      ],
    },
  };
}

function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });
}
