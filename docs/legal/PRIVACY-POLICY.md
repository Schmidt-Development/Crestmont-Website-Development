# Privacy Policy

> **DRAFT v3 — NOT LEGAL ADVICE — NOT APPROVED FOR USE.** Prepared for review by a licensed attorney. Placeholders in [BRACKETS] must be completed. Items marked **[FOUNDER DECISION]** need a business decision; items marked **[COUNSEL]** need legal analysis. Do not publish, send to customers, or accept payments under this text until counsel has approved it and a new agreement version is recorded in the platform.

**Version:** Draft v3 (prepared 2026-10-28) · **Supersedes (on approval):** published draft `privacy` (agreement kind `privacy_policy`, version `2026-10-draft-2`). Accepted at registration. **Effective date:** [EFFECTIVE DATE]

---

## 1. Who We Are

This policy explains how [LEGAL ENTITY NAME], a [ENTITY TYPE AND STATE] trading as Crestmont Website Development ("**Crestmont**", "**we**", "**us**"), handles Personal Data collected through crestmontwebsitedevelopment.com, the customer portal (the "**Portal**"), our telephone lines and our Services. Our address is [REGISTERED ADDRESS]. Privacy questions can be sent to [NOTICE EMAIL] (currently published as legal@crestmontwebsitedevelopment.com).

Defined terms (**Customer**, **Services**, **Customer Data**, **Personal Data**, **AI Features**, **AI Receptionist**, **Subprocessor**, **Security Incident**) have the same meaning as in our Master Services Agreement.

**Scope.** This policy covers Personal Data that Crestmont controls: data about visitors to our website, people who contact us, and our Customers' staff who use the Portal. It does **not** cover Customer Data that we process for a Customer, for example submissions to a website we host for a Customer. That data is governed by the Customer's own privacy notice and our Data Processing Addendum with that Customer.

## 2. Personal Data We Collect

| Category | Examples | Source |
|---|---|---|
| Contact and enquiry data | Name, email, phone, business name, website address, message and quote-request content | You |
| Account data | Login email, display name, hashed password, two-factor settings, session records (time, IP address, browser) | You; our systems |
| Project data | Files, content, approvals, messages, revision history, support tickets | You and your colleagues |
| Billing data | Billing contact, invoices, payment status; limited card details such as brand and last four digits (we never receive full card numbers) | You; our payment processor |
| Agreement records | Which document versions you accepted, when, from which IP address and browser | Our systems |
| Call data | Phone number, call time and outcome, and **only with your consent** a transcript, recording link and summary | You; our voice provider |
| Technical and security data | IP address, browser type, failed sign-in attempts, rate-limit events, audit logs | Our systems |
| Attribution data | Campaign parameters in the link you followed and the referring page (Section 7) | Your browser |

We do not knowingly collect sensitive data such as government ID numbers, health information or precise geolocation.

## 3. How We Use Personal Data

| Purpose | Legal basis (where the law requires one) |
|---|---|
| Responding to enquiries and preparing quotes | Steps at your request before a contract; legitimate interests |
| Delivering, supporting and billing for Services | Performance of contract |
| Recording agreement acceptance | Legal obligation; legitimate interests (proof of contract) |
| Securing accounts, preventing fraud and abuse | Legitimate interests; legal obligation |
| Transactional emails (account, project, invoice, ticket) | Performance of contract |
| Crediting enquiries to the campaign that brought you | Legitimate interests (Section 7) |
| Tax, accounting and legal compliance | Legal obligation |

We do not send marketing emails at present. **[FOUNDER DECISION: If marketing email is introduced, add consent and unsubscribe handling, CAN-SPAM content, and a section here.]** **[COUNSEL: The legal-basis column is relevant only if non-U.S. law applies. Keep it or remove it.]**

## 4. AI Processing

We use AI Features to help draft content, summarise enquiries and tickets, qualify and route requests, and draft support replies. By default, these run on a model hosted on hardware we control. If we enable an optional third-party AI provider, it is listed in Section 5.

- A person reviews AI output before it is used in a decision that affects you.
- AI is **never** used to approve or deny refunds, accept contracts, set prices or approve releases.
- We do not use your Personal Data to train AI models.

**[COUNSEL: Whether any state automated-decision-making or profiling rules apply to lead qualification. We believe they do not apply because there are no legal or similarly significant effects, but this needs confirmation.]**

## 5. How We Share Personal Data

We do not sell Personal Data, and we do not share it for cross-context behavioural advertising. We share it only:

- **With service providers** that help us operate, under contracts that limit their use of the data:

| Provider | Purpose |
|---|---|
| Cloudflare | Hosting, database, file storage, network security |
| Stripe | Payments, subscriptions, refunds |
| Resend | Transactional email |
| Retell AI | AI Receptionist telephony (only once the AI Receptionist is live) |
| Anthropic | AI drafting (only if the optional paid adapter is enabled) |
| GitHub | Source-code hosting (no Personal Data expected) |

- **Within your organisation:** project content you post in the Portal is visible to other authorised users of your Customer organisation and to the Crestmont staff assigned to it.
- **For legal reasons:** to comply with law or legal process, to protect rights and safety, or to investigate abuse.
- **In a business transfer:** to a successor in a merger or acquisition, subject to this policy.

## 6. Cookies and Similar Technologies

We use:
- **Strictly necessary cookies** for sign-in sessions, security (CSRF protection) and short-lived notices.
- **One first-party attribution cookie (`cm_attr`)**, which lasts up to 30 days. It records three things: the campaign (UTM) parameters in the link you followed; the referring page, reduced to its address without query string; and the page on our site where you first arrived. We use this so that a quote request can be credited to that source. It is HttpOnly, is read only by our server, and is never shared with advertisers.

We do **not** use third-party analytics or advertising cookies. If that changes, we will update this policy and ask for consent where required.

## 7. Do Not Track and Global Privacy Control

If your browser sends a Do Not Track (DNT) or Global Privacy Control (GPC) signal, we do not record the referring page in `cm_attr`. Campaign parameters in the link itself and your landing page on our site are still recorded. Because we do not sell or share Personal Data for advertising, there is no further sale or sharing to opt out of. **[COUNSEL: Whether recording campaign parameters despite a GPC signal is acceptable, or whether the cookie should be skipped entirely when GPC is present.]**

## 8. Phone Calls and Recordings

Our AI Receptionist is not yet live. When it is:
- it tells callers at the start of every call that they are speaking with an AI system;
- it asks for consent before the call is recorded or transcribed. Without consent, transcripts, recordings and summaries are discarded, and we keep only the call record (number, time, outcome);
- it does not discuss refunds, contracts or account details, and it passes those matters to a person.

**[COUNSEL: Michigan and all-party-consent state recording laws; state AI-disclosure laws.]**

## 9. Retention

We keep Personal Data only as long as needed for the purposes above. Our retention schedule (`docs/RETENTION-SCHEDULE.md`) currently provides:

| Data | Period |
|---|---|
| Expired or revoked sessions | Deleted 30 days after expiry |
| Used or expired sign-in and reset tokens | Deleted 7 days after use or expiry |
| Rate-limit counters | Deleted after 2 days |
| Security events | Proposed: 365 days* |
| Email message bodies (delivery log kept) | Proposed: 730 days* |
| Call transcripts and recording links | Proposed: 90 days after the call* |
| Deleted Portal files | Proposed: purged 30 days after deletion* |
| Financial records, agreement Acceptance Records, privacy-request records, audit log | Kept for legal, tax and evidentiary purposes (typically 7 years for financial records; the audit log is append-only) |
| Account, project and ticket data | For the life of the customer relationship, then on request (Section 10) |
| Backups | Proposed: 35 days (daily) and 12 months (monthly)* |

\* **Proposed periods are not yet active and are pending Founder and counsel approval.** **[FOUNDER DECISION: approve each period.]** **[FOUNDER DECISION: a retention period for enquiries that never become projects. The current published draft promises deletion "after a reasonable period", but the Platform has no job that does this.]**

## 10. Your Rights

**10.1 Everyone.** Whatever your location, you may ask us to access, correct, delete or provide a copy of your Personal Data. We will respond within [RESPONSE DAYS] days.

**10.2 U.S. state privacy laws.** Residents of certain states (for example California, Colorado, Connecticut, Virginia, Oregon, Texas and others) may have statutory rights to know, access, correct, delete, port, and opt out of sale, sharing, targeted advertising and certain profiling, and to appeal our decision. These laws apply to businesses that meet thresholds such as revenue or the number of consumers whose data they process. **[COUNSEL: Determine whether Crestmont currently meets any state threshold; Michigan has no comprehensive consumer privacy statute as of drafting, which should be confirmed. Decide whether to offer these rights voluntarily to everyone (recommended for simplicity) and whether a California "notice at collection" is required.]**

**10.3 Non-discrimination.** We will not treat you differently for exercising your rights.

## 11. How to Exercise Your Rights

- **Self-service (Portal users):** go to **/account/privacy**. You can download an export of your data immediately. It includes your profile, memberships, sessions, accepted agreements and your organisation's projects, messages, tickets, orders, invoices and file list. It excludes password hashes, MFA secrets and internal staff notes. You can also submit a deletion request.
- **By email:** [NOTICE EMAIL].

**Deletion.** Staff process deletion requests. Completion anonymises your account (name, email and credentials), removes your memberships and notifications, anonymises linked contact records and signs you out everywhere. We keep financial, agreement and audit records where the law requires; these then refer to an anonymised identifier. The account owner of Crestmont itself cannot be deleted through this process.

**Verification.** For self-service requests, signing in to your account verifies you. For email requests, we verify your identity by [VERIFICATION METHOD, e.g. confirming control of the account email]. You may use an authorised agent with written permission. **[COUNSEL: verification standard and agent process.]**

**Appeals.** If we deny a request, we tell you why. You may appeal by emailing [NOTICE EMAIL] with "Privacy appeal" in the subject line.

## 12. Children

Our website and Services are for businesses. They are not directed to children under 13, and we do not knowingly collect Personal Data from children under 13, consistent with the Children's Online Privacy Protection Act (COPPA). If you believe a child has given us Personal Data, contact us and we will delete it. Customers whose own websites are directed to children must tell us in writing before ordering, and remain responsible for COPPA compliance on those websites.

## 13. Security

We protect Personal Data with encryption in transit, hashed passwords, multi-factor authentication (required for staff), role-based access, tenant isolation, private file storage and an append-only audit log. A full list, including controls **not** yet in place, is in Annex 3 of our Data Processing Addendum. Note in particular that files uploaded to the Portal are not yet scanned for malware. No system is perfectly secure.

## 14. Breach Notification

If a Security Incident affects your Personal Data, we will notify you and the relevant authorities as required by applicable law, including the Michigan Identity Theft Protection Act where it applies. **[COUNSEL: confirm the applicable state breach-notification laws.]** Where we process data for a Customer, we notify that Customer under our Data Processing Addendum.

## 15. International Users

We operate in the United States, and data is processed there. **[COUNSEL: Whether the Services are offered outside the U.S.; see DPA Section 11.]**

## 16. Changes

We will post updates on this page with a new effective date. Material changes are emailed to account holders before they take effect. Every version is stored in our Platform and cannot be changed afterwards.

## 17. Contact

[LEGAL ENTITY NAME], [REGISTERED ADDRESS] · [NOTICE EMAIL]
