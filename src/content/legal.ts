// Policy drafts for attorney review (LEGAL-001, LEGAL-002, WEB-008). These are DRAFTS: every page
// renders a visible "Draft — pending attorney review" banner and nothing here claims attorney
// approval (LEGAL-004 stays open until a real review is recorded).
// Facts that are not yet established (legal entity, registered address, staffed hours) are passed
// in from business_settings and are never invented.
import { PACKAGES, MAINTENANCE_PLANS } from "../domain/catalog.ts";
import { DEFAULT_INACTIVITY_POLICY } from "../domain/project.ts";
import { ATTRIBUTION_MAX_AGE } from "../services/leads.ts";

const ATTRIBUTION_DAYS = ATTRIBUTION_MAX_AGE / 86400;

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

export const LEGAL_SLUGS = ["privacy", "terms", "development-agreement", "custom-development-agreement", "maintenance-agreement", "data-processing", "refunds", "cancellation", "support", "acceptable-use", "accessibility", "disclosures"] as const;
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
        { heading: "Cookies", paras: ["We use strictly necessary cookies for sign-in sessions, security (CSRF protection) and short-lived notices.", `We also set one first-party cookie (cm_attr) that remembers how you arrived at our site (for example the campaign name in a link and the page you came from) for up to ${Math.round(ATTRIBUTION_DAYS)} days, so that a quote request can be credited to that source. It is read only by our own server and never shared with advertisers. If your browser sends a Do Not Track or Global Privacy Control signal, we do not record the referring page.`, "We do not use third-party analytics or advertising cookies. If that changes, this policy will be updated and any required consent will be requested."] },
        { heading: "Phone calls", paras: ["If we offer an automated phone receptionist, it tells callers at the start of the call that they are speaking with an AI system. Calls are recorded or transcribed only after the caller is told and, where the law requires it, has agreed. Call details are used to answer your enquiry and are kept under the same rules as other enquiries."] },
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
    "custom-development-agreement": {
      slug: "custom-development-agreement", title: "Custom development agreement (draft)", summary: "The draft agreement that governs custom website and software projects quoted individually.",
      sections: [
        { heading: "Parties", paras: [`This agreement is between ${who} ("Crestmont") and the customer organisation named on the accepted quote ("you"). It applies to custom projects quoted individually, not to the fixed-price packages.`] },
        { heading: "Scope", paras: ["The scope is the line items, deliverables and assumptions in the written quote you accept in the customer portal. The quote version you accepted is recorded with its date, the person who accepted it and a fingerprint of its text. Anything not in the accepted quote is out of scope."] },
        { heading: "Payment schedule", list: [
          "50% of the quoted total is invoiced when you accept the quote; work is scheduled once it is paid.",
          "25% is invoiced at the design-approval milestone.",
          "The final 25% is invoiced when the site is ready to launch; launch takes place once it is paid.",
          "Each milestone is invoiced once. Amounts are calculated by the platform from the accepted quote, never entered by hand.",
        ] },
        { heading: "Change orders", paras: ["Work outside the accepted scope needs a written change order stating the added scope, the price and any change to the timeline. Change-order work starts only after you approve it and, where the change order says so, after it is paid."] },
        { heading: "Your responsibilities", list: ["Provide content, brand assets, credentials and decisions needed for the work.", "Review and respond to approval requests and revision rounds.", "Confirm you have the rights to the materials you supply."] },
        { heading: "Timeline and inactivity", paras: [`Dates in the project plan assume timely responses. If we are waiting on you, reminders are sent after ${pol.remindAfterDays.join(" and ")} days, the project is escalated after ${pol.escalateAfterDays} days and may be paused after ${pol.pauseAfterDays} days. A paused project can be restarted; it is never cancelled without notice.`] },
        { heading: "Acceptance and launch", paras: ["Before launch the work passes Crestmont's internal quality checks and is presented for your approval. Launch requires your recorded approval and payment of the final milestone. After launch you record final acceptance of the handoff."] },
        { heading: "Ownership", paras: ["When all amounts due under this agreement are paid, the custom work product created for you is assigned to you, except third-party components (themes, plugins, fonts, libraries, stock media and services), which stay under their own licences, and Crestmont's pre-existing tools and know-how, which are licensed to you for use with the delivered work."] },
        { heading: "Confidentiality and data", paras: ["Each side keeps the other's non-public information confidential. Where Crestmont processes personal data on your behalf, the data processing addendum applies."] },
        { heading: "Warranty, liability and disputes", paras: ["Crestmont will correct defects in delivered work that do not match the accepted scope when reported within the warranty period. The warranty period, any limitation of liability, the governing law and the dispute-resolution process will be set during attorney review and are not yet part of this draft."] },
        { heading: "Termination", paras: ["Either side may end the agreement in writing. Work completed and approved up to that point is invoiced at the milestone amounts already due; refunds are handled under the refund policy."] },
      ],
    },
    "maintenance-agreement": {
      slug: "maintenance-agreement", title: "Maintenance agreement (draft)", summary: "The draft agreement for monthly maintenance plans.",
      sections: [
        { heading: "Parties and plans", paras: [`This agreement is between ${who} ("Crestmont") and the customer organisation that subscribes to a maintenance plan (${Object.values(MAINTENANCE_PLANS).map((m) => `${m.name} ${usd(m.monthlyCents)}/month`).join(", ")}).`] },
        { heading: "What each plan includes", paras: ["The services included in each plan (hosting, maintenance hours, content updates, security updates, monitoring, backups and support response targets) are listed on the plan page at the time you subscribe, and the version you subscribed to is recorded. Plan contents are awaiting final approval and will be published before maintenance plans are sold."] },
        { heading: "Billing", paras: ["Plans are billed monthly in advance through our payment provider and renew automatically until cancelled. Unused hours and updates do not carry over. Work beyond the plan needs your approval before it starts and is quoted or billed as stated on the plan page."] },
        { heading: "Requests", paras: ["Maintenance requests are made through the customer portal or a support ticket and are handled during staffed hours in line with the support policy."] },
        { heading: "Cancellation", paras: ["You can cancel from the billing section of the customer portal. Cancellation takes effect at the end of the current billing period. Your domain remains yours, and backups and handover materials are provided in line with the cancellation policy."] },
        { heading: "Limits", paras: ["Response targets are goals for an initial response, not guarantees of resolution time. Service levels, any credits, the limitation of liability and the governing law will be set during attorney review and are not yet part of this draft."] },
      ],
    },
    "data-processing": {
      slug: "data-processing", title: "Data processing addendum (draft)", summary: "How Crestmont handles personal data it processes on behalf of customers.",
      sections: [
        { heading: "Roles", paras: [`When Crestmont builds, hosts or maintains a website for you, you decide what personal data the site collects and why; ${who} processes that data on your behalf and only on your documented instructions. For data about you as our customer, our privacy policy applies instead.`] },
        { heading: "Processing details", list: [
          "Purpose: building, hosting, maintaining and supporting your website and related services.",
          "Data: whatever your website's visitors and customers submit (for example contact-form entries), plus account data of your staff who use the customer portal.",
          "Duration: the term of your project or maintenance plan, then return or deletion as described below.",
        ] },
        { heading: "Crestmont's commitments", list: [
          "Process personal data only to provide the services and as you instruct.",
          "Keep it confidential and limit access to staff who need it, each with individual accounts, two-factor authentication and logged access.",
          "Protect it with security measures including encryption in transit, access controls, audit logging and backups.",
          "Help you respond to requests from people exercising their privacy rights.",
          "Notify you without undue delay after becoming aware of a personal data breach affecting your data.",
          "At the end of the services, return or delete your personal data unless law requires it to be kept.",
        ] },
        { heading: "Subprocessors", paras: ["Crestmont uses service providers for hosting, file storage, email delivery, payments and AI-assisted drafting. The current list of subprocessors and where they process data will be published with the final version of this addendum, and you will be told before a new subprocessor is added."] },
        { heading: "Status", paras: ["This addendum is a draft for attorney review. Jurisdiction-specific terms (for example standard contractual clauses or state privacy-law terms) will be added during that review where they apply."] },
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
        { heading: "Policies", paras: ["Our privacy policy, terms of service, development, maintenance and data processing agreements, refund, cancellation, support and acceptable use policies are linked below. They are drafts pending attorney review."] },
      ],
    },
  };
}

function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });
}
