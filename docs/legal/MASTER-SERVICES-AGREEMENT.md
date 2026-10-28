# Master Services Agreement

> **DRAFT v3 — NOT LEGAL ADVICE — NOT APPROVED FOR USE.** Prepared for review by a licensed attorney. Placeholders in [BRACKETS] must be completed. Items marked **[FOUNDER DECISION]** need a business decision; items marked **[COUNSEL]** need legal analysis. Do not publish, send to customers, or accept payments under this text until counsel has approved it and a new agreement version is recorded in the platform.

**Version:** Draft v3 (prepared 2026-10-28) · **Supersedes (on approval):** published drafts `terms` (terms_of_service, as it applies to purchased Services), `development-agreement`, `custom-development-agreement`, `maintenance-agreement`, `refunds`, `cancellation` and `support` (version `2026-10-draft-1` / `2026-10-draft-2`). See `docs/legal/README.md`.

---

## 1. Definitions

Capitalised terms have the meanings below. The same terms are used in the Data Processing Addendum ("**DPA**"), Privacy Policy, Website Terms of Use and Acceptable Use Policy ("**AUP**").

1.1 **"Crestmont"** means [LEGAL ENTITY NAME], a [ENTITY TYPE AND STATE], with its registered address at [REGISTERED ADDRESS], trading as Crestmont Website Development.

1.2 **"Customer"** means the business or organisation named in an Order, and its permitted successors.

1.3 **"Services"** means the website design and development, hosting, maintenance, support, AI Features and other services Crestmont provides under an Order.

1.4 **"Deliverables"** means the websites, pages, designs, code, configurations, documentation and other work product that Crestmont creates specifically for Customer and delivers under an Order.

1.5 **"Customer Content"** means text, images, logos, trademarks, data, credentials, files and other materials that Customer, or anyone acting for Customer, provides to Crestmont or uploads to the Portal.

1.6 **"Customer Data"** means all data, including Personal Data, that Crestmont processes on Customer's behalf in providing the Services. Examples are website form submissions, Portal content and AI Receptionist call records for Customer's lines.

1.7 **"Order"** means either (a) checkout of a fixed-price package (Starter, Business or Premium) or a Maintenance Plan in the Portal, or (b) a written quote ("**Quote**") that Customer accepts in the Portal. An "Order/Quote" reference in any Crestmont document means an Order.

1.8 **"Statement of Work"** or **"SOW"** means the scope description, line items, Deliverables, assumptions and exclusions contained in or attached to an accepted Quote.

1.9 **"Change Order"** means a written change to an Order's scope, price or timeline, approved by Customer in the Portal.

1.10 **"Launch Approval"** means Customer's recorded approval in the Portal for the Deliverables to be deployed to production.

1.11 **"Maintenance Plan"** means a recurring monthly hosting and maintenance subscription described in Schedule B.

1.12 **"AI Features"** means functions of the Services that use machine-learning or large-language-model systems to generate, summarise, classify or route content, including AI-assisted draft copy and automated first builds. See Schedule C.

1.13 **"AI Receptionist"** means an automated voice agent that answers inbound telephone calls using AI Features. See Schedule C.

1.14 **"Subprocessor"** means a third party engaged by Crestmont that processes Customer Data, as listed in DPA Annex 2.

1.15 **"Personal Data"** means information that identifies, relates to or could reasonably be linked to an identified or identifiable individual, and any information defined as "personal information" or "personal data" under applicable law.

1.16 **"Security Incident"** means a confirmed breach of security leading to accidental or unlawful destruction, loss, alteration, unauthorised disclosure of, or access to, Customer Data.

1.17 **"Portal"** means Crestmont's customer portal and related online systems (together with Crestmont's website, the "**Platform**").

1.18 **"Acceptance Record"** means the record the Platform creates when a person accepts a document. See Section 24.

---

## 2. Parties and Structure

2.1 **Parties.** This Master Services Agreement ("**Agreement**") is between Crestmont and Customer. The individual who accepts it confirms that he or she has authority to bind Customer. **[COUNSEL: Confirm treatment of sole proprietors and individuals who buy for a business. Consider whether any consumer-protection law applies if a natural person buys a package for personal use. The Platform does not currently distinguish business from consumer buyers.]**

2.2 **Business use.** The Services are offered for business purposes only.

2.3 **Structure.** This Agreement consists of these general terms, the Schedules, the DPA and each Order. Each Order is governed by this Agreement.

2.4 **Order of precedence.** If documents conflict, they apply in this order: (a) a Change Order, for the matters it changes; (b) the SOW or Order, for the scope and price of that Order only; (c) the DPA, for the processing of Personal Data; (d) the Schedules; (e) these general terms; (f) the AUP; (g) the Website Terms of Use, which apply to use of the Platform and not to purchased Services. An Order cannot override Sections 12, 13, 15 or 16 unless it expressly says so and refers to the Section number.

2.5 **Founding-stage status.** Crestmont will not enter an Order until the details in Section 1.1 are completed and published in the Platform's business disclosures.

---

## 3. Ordering

3.1 **Packages.** Fixed-price packages are bought at checkout. The published scope for each package as at this draft is:

| Package | Price | Page limit | Revision rounds | Payment |
|---|---|---|---|---|
| Starter | $999 | up to 5 pages | 2 | 100% upfront |
| Business | $2,499 | up to 12 pages | 3 | 100% upfront |
| Premium | from $4,999 | up to 25 pages within approved scope | 4 | 100% upfront |

A Premium Order may include additional quoted line items above the base price, but never less than the base price. Starter and Business are fixed-price. Additional work on those packages requires a Quote or a Change Order.

3.2 **Custom work.** Custom work is ordered by accepting a Quote. The SOW sets out the scope. Anything not in the accepted SOW is out of scope.

3.3 **Quote validity.** A Quote is valid for [QUOTE VALIDITY DAYS] days unless it states otherwise. **[FOUNDER DECISION: 14 / 30 / 60 days.]**

3.4 **Scheduling.** Crestmont schedules work after the first payment in Section 4 is confirmed by its payment processor.

3.5 **Prices.** Published prices are set by Crestmont and change only through Crestmont's internal approval process. A price change does not affect an Order already accepted.

---

## 4. Fees and Payment

4.1 **Packages.** Package fees are due in full at checkout.

4.2 **Custom milestones.** Unless the SOW states otherwise, custom Orders are billed in three milestones calculated by the Platform from the accepted Quote:
(a) **50% deposit**, invoiced when Customer accepts the Quote;
(b) **25%**, invoiced only after Customer approves the design milestone in the Portal;
(c) **25%**, invoiced only after Customer gives Launch Approval. Deployment to production follows payment (Section 8.3).
Each milestone is invoiced once. Any rounding difference falls in the final milestone.

4.3 **Payment method.** Payments are processed by Crestmont's payment processor (currently Stripe). Crestmont does not receive or store full card numbers. Invoices are due [PAYMENT TERMS] after issue. **[FOUNDER DECISION: due on receipt / Net 7 / Net 15.]**

4.4 **Late payment.** If an undisputed invoice is unpaid when due, Crestmont may, after written notice: (a) pause work under the affected Order; (b) charge late interest of [LATE FEE RATE]; and (c) withhold deployment and transfer of Deliverables until payment. **[FOUNDER DECISION: (i) no late fee; (ii) 1.5% per month or the maximum lawful rate, whichever is lower; (iii) a flat fee of $[X].]** **[COUNSEL: Confirm lawful late-fee and interest limits in [GOVERNING LAW STATE] and in states where Customers are located.]** The Platform currently pauses work only for inactivity, not for non-payment. Pausing for non-payment would need a manual decision recorded by staff.

4.5 **Taxes.** Fees exclude sales, use, value-added and similar taxes. Customer pays applicable taxes. These are shown on the invoice using the tax configuration recorded by Crestmont. Crestmont pays taxes on its own income. **[COUNSEL: Taxability of website development, hosting and maintenance subscriptions in Michigan (the likely home state, to be confirmed) and in customers' states. Nexus. Whether a resale or exemption certificate process is needed.]**

4.6 **Disputed invoices.** Customer must notify Crestmont of any good-faith dispute in writing within [DISPUTE DAYS] days of the invoice date and pay any undisputed amount. The parties will work to resolve the dispute under Section 18.1. Customer agrees to raise billing concerns with Crestmont before starting a payment-card chargeback, without limiting any rights Customer has under card-network rules.

4.7 **Third-party costs.** Domain registration, premium plugins, fonts, stock media, paid APIs and other third-party fees are not included unless the Order says so. Crestmont will not incur a third-party cost on Customer's behalf without Customer's prior approval.

---

## 5. Change Orders

5.1 **Requests.** Either party may propose a change. Crestmont will describe the added or changed scope, price, payment terms and timeline impact in a Change Order.

5.2 **Approval before work.** Change Order work starts only after Customer approves the Change Order in the Portal and, where the Change Order requires it, pays for it. Crestmont does not expand scope automatically and has no obligation to perform unapproved changes.

5.3 **Revisions beyond allowance.** A revision request made after the included revision rounds are used up (Section 7.3) requires a Change Order.

---

## 6. Customer Obligations

6.1 Customer will:
(a) provide accurate information, Customer Content, brand assets, access credentials and decisions needed for the work, within the timeline;
(b) appoint at least one verified customer administrator in the Portal who can give approvals;
(c) review and respond to approval requests and revision rounds;
(d) ensure that it has all rights, licences and consents needed for Customer Content and for Crestmont's use of it under this Agreement;
(e) comply with the AUP and applicable law in its use of the Deliverables and Services, including laws on privacy, marketing, accessibility, consumer protection and the content of its website;
(f) keep its Portal credentials secure, and enable two-factor authentication where offered (strongly recommended); and
(g) give its own privacy notices and obtain any consents needed from visitors to its website and callers to its lines.

6.2 **Regulated content.** Customer is responsible for legal review of regulated claims on its website (for example health, financial, legal or professional claims, pricing and promotional terms, testimonials and endorsements). Crestmont does not provide legal advice.

6.3 **Uploaded files.** Files uploaded to the Portal are **not currently scanned for malware**; the Portal labels them "not yet scanned". Customer should upload only files from trusted sources. Before a file is shared by link, the person sharing must confirm that they know it is unscanned.

---

## 7. Review, Revisions and Acceptance

7.1 **Internal quality checks.** Before presenting work for review, Crestmont completes its internal quality checks. These include engineering completion, quality assurance, and security and accessibility review.

7.2 **Review.** Crestmont presents work for Customer review in the Portal. Customer will either approve it or submit one consolidated list of revision requests per round within [REVIEW DAYS] business days. **[FOUNDER DECISION: 5 / 7 / 10 business days.]**

7.3 **Revision rounds.** Each package includes the revision rounds in Section 3.1 (Starter 2, Business 3, Premium 4). Custom Orders include the rounds stated in the SOW, or [DEFAULT CUSTOM ROUNDS] if none are stated. Every round submitted is counted. A "revision" is a change to the delivered work within the existing scope. New pages, features or integrations are out of scope.

7.4 **Defects are not revisions.** Correcting work that does not match the accepted scope does not use a revision round.

7.5 **Deemed approval.** **[FOUNDER DECISION: (i) no deemed approval, so silence leads only to the inactivity process in Section 9; or (ii) deemed approval of a review stage after [N] days of silence following two reminders. The Platform currently implements option (i): it never records an approval on the customer's behalf.]**

---

## 8. Launch Approval and Handoff

8.1 **No launch without approval.** Crestmont deploys Deliverables to production only after **all** of the following: internal quality certification, Customer's Launch Approval, payment verification (Section 8.3), and Crestmont's internal deployment authorisation. Crestmont never launches on Customer's behalf without Launch Approval.

8.2 **Customer responsibility for approved content.** By giving Launch Approval, Customer confirms that it has reviewed the website's content, including any content produced with AI Features, and approves its publication.

8.3 **Payment before launch.** Launch requires that all amounts due under the Order have been paid, unless Crestmont's owner records a documented payment exception for that project. **[FOUNDER DECISION: Keep the documented owner exception, which the Platform supports, or remove it from the contract.]**

8.4 **Handoff.** After launch, Crestmont delivers a handoff package: access details, documentation, ownership information and training materials as applicable. Customer records final acceptance of the handoff in the Portal. If Customer does not record final acceptance or report a material defect within [HANDOFF DAYS] days of the handoff, the handoff is treated as accepted for warranty purposes (Section 14.1). **[FOUNDER DECISION: 10 / 14 / 30 days.]**

---

## 9. Timeline and Inactivity

9.1 **Estimates.** Timelines in an Order are good-faith estimates. They assume Customer responds on time.

9.2 **Inactivity process.** When a project is waiting on Customer, the Platform:
(a) sends reminders after **7** and **14** days without a response;
(b) escalates to Crestmont's project manager after **21** days; and
(c) may **pause** the project after **30** days, but only once the escalation has occurred.

9.3 **Pauses.** While a project is paused, timelines are suspended and Crestmont may reassign resources. A paused project resumes at the stage where it was paused. Restart scheduling depends on availability, and the restart lead time is [RESTART LEAD TIME]. **[FOUNDER DECISION: restart lead time and whether a restart fee applies.]**

9.4 **No silent cancellation.** A project is never cancelled automatically. Cancellation requires an authorised Crestmont owner decision with a recorded reason, and notice to Customer. **[FOUNDER DECISION: Whether a project paused for more than [90/180] days may be closed on written notice, and what happens to the payments already made. Refunds would be handled under Schedule E.]**

---

## 10. Intellectual Property

10.1 **Customer Content.** Customer keeps all rights in Customer Content. Customer grants Crestmont a non-exclusive, royalty-free licence to use, copy, modify and display Customer Content only to provide the Services.

10.2 **Assignment on full payment.** When Crestmont has received all amounts due under an Order, Crestmont assigns to Customer all of its right, title and interest in the Deliverables created specifically for Customer under that Order. This assignment excludes Crestmont Materials (Section 10.3) and Third-Party Components (Section 10.4). Until full payment, Crestmont grants Customer a limited licence to review the Deliverables only. **[COUNSEL: Assignment versus work-made-for-hire language; confirmatory assignment and further-assurances clause; treatment of partially paid, terminated Orders.]**

10.3 **Crestmont Materials.** Crestmont keeps ownership of its pre-existing and independently developed tools, templates, starter code, components, libraries, build automation, prompts, know-how and general skills ("**Crestmont Materials**"). If Crestmont Materials are incorporated into the Deliverables, Crestmont grants Customer a perpetual, non-exclusive, worldwide, royalty-free, non-transferable (except with the Deliverables) licence to use, modify and host them as part of the Deliverables.

10.4 **Third-Party and open-source components.** Themes, plugins, fonts, libraries, stock media, hosted services and open-source software ("**Third-Party Components**") are licensed under their own terms. Crestmont will identify material Third-Party Components in the handoff documentation. Crestmont will not knowingly include components whose licence would require Customer to disclose its proprietary code, unless Customer agrees. **[COUNSEL: Open-source notice obligations; stock imagery licence scope, including whether licences transfer to Customer.]**

10.5 **AI-assisted output.** Some Deliverables may be produced with AI Features. Crestmont assigns whatever rights it holds in that output under Section 10.2. Customer acknowledges that copyright protection for AI-generated material may be limited, and Crestmont does not warrant that such material is protectable. **[COUNSEL: Current U.S. Copyright Office position and disclosure implications.]**

10.6 **Portfolio use.** Crestmont may name Customer as a client and display screenshots and a description of the public website in its portfolio **only with Customer's consent**. Customer may withdraw consent for future use at any time by notice. Crestmont never publishes testimonials without documented permission. **[FOUNDER DECISION: (i) consent by opt-in checkbox at Order (recommended); (ii) consent by default with opt-out; or (iii) a separate request after launch.]**

10.7 **Feedback.** Crestmont may use suggestions about its Services freely, without using Customer's Confidential Information.

---

## 11. Hosting, Domains and Accounts

11.1 **Hosting.** Where Crestmont hosts the Deliverables, hosting is provided on third-party cloud infrastructure (currently Cloudflare) under a Maintenance Plan (Schedule B) or as stated in the Order.

11.2 **Domains in Customer's name.** Domain names are registered in Customer's name and under an account Customer controls. If Crestmont registers or renews a domain for Customer, it does so as Customer's agent, lists Customer as registrant, and passes the cost through under Section 4.7. **[FOUNDER DECISION: Whether Crestmont ever holds registrar accounts for Customers, or always requires Customer-owned registrar accounts with delegated access.]**

11.3 **Third-party accounts.** Analytics, search console, business-profile, payment and similar accounts are created in Customer's name wherever the provider allows. Crestmont uses delegated access where possible. Crestmont stores any Customer credentials only as needed and removes its access when the Order ends, or earlier if Customer asks.

11.4 **Account access handover.** At handoff, and on termination for any reason after full payment, Crestmont will transfer or confirm Customer's administrative access to the domain, the hosting configuration Customer is entitled to, the source code repository for the Deliverables, and third-party accounts set up for Customer.

11.5 **Transition assistance.** On termination of a Maintenance Plan, Crestmont will, if Customer asks within [TRANSITION DAYS] days, provide an export of the website files and database content it hosts for Customer, in a commonly used format. Crestmont will keep the site online for [TRANSITION HOSTING DAYS] days if the plan's fees are paid for that period. **[FOUNDER DECISION: transition window and whether assistance beyond the export is billable at the overage rate.]**

---

## 12. Confidentiality

12.1 **Definition.** "**Confidential Information**" means non-public information disclosed by one party to the other that is marked confidential or that a reasonable person would understand to be confidential. This includes credentials, pricing in Quotes, and unpublished designs.

12.2 **Obligations.** The recipient will use Confidential Information only to perform or receive the Services. It will protect that information with at least reasonable care, and disclose it only to personnel and Subprocessors who need to know it and are bound by similar obligations.

12.3 **Exclusions.** Information is not Confidential Information if it is or becomes public without the recipient's fault, was known to the recipient without restriction, is independently developed, or is rightfully received from a third party.

12.4 **Compelled disclosure.** The recipient may disclose information if required by law. Where lawful, it will give prompt notice and reasonable help to seek protection.

12.5 **Duration.** These obligations last during the Agreement and for [CONFIDENTIALITY YEARS] years afterwards. Credentials and trade secrets remain protected for as long as they stay confidential.

---

## 13. Data Protection and Security

13.1 **DPA.** The DPA forms part of this Agreement and governs Crestmont's processing of Customer Data that is Personal Data. Crestmont's handling of personal information about Customer's own staff as account holders and billing contacts is described in the Privacy Policy.

13.2 **Security.** Crestmont maintains the technical and organisational measures in DPA Annex 3. Crestmont describes those measures accurately, including the controls that are **not** yet in place, and makes no security certification.

13.3 **Security Incidents.** Crestmont notifies Customer of Security Incidents as stated in the DPA.

---

## 14. Warranties and Disclaimers

14.1 **Conformance warranty.** For [WARRANTY PERIOD] after launch (or after delivery, if there is no launch), Crestmont will correct, at no charge, defects that cause the Deliverables not to conform materially to the accepted scope, if Customer reports them in writing during that period. This correction is Customer's sole remedy for breach of this warranty. **[FOUNDER DECISION: 30 / 60 / 90 days.]**

14.2 **Exclusions.** The warranty does not cover issues caused by Customer Content, changes made by anyone other than Crestmont, third-party services or Third-Party Components, browser or platform changes after launch, misuse, or failure to apply updates that Crestmont provided or recommended.

14.3 **Mutual warranties.** Each party warrants that it has authority to enter this Agreement. Customer warrants that Customer Content and its instructions do not infringe third-party rights or violate law.

14.4 **No guaranteed outcomes.** Crestmont does not guarantee search rankings, traffic, leads, sales, conversion rates or other business results. Search engines, payment processors, hosting providers, telephony carriers and AI providers are outside Crestmont's control.

14.5 **Accessibility.** Crestmont designs to the Web Content Accessibility Guidelines (WCAG) 2.1 Level AA as its target, but does not warrant full conformance unless an Order expressly includes an accessibility audit. Customer content added after handoff is Customer's responsibility. **[COUNSEL: ADA website litigation risk allocation; whether to offer an accessibility audit as an optional line item.]**

14.6 **Disclaimer.** Except as expressly stated in this Agreement, and to the maximum extent permitted by law, the Services and Deliverables are provided "as is". Crestmont disclaims all implied warranties, including merchantability, fitness for a particular purpose, non-infringement and uninterrupted or error-free operation. **[COUNSEL: Conspicuousness requirements for disclaimers under the UCC as adopted in [GOVERNING LAW STATE] (if applicable to services) and in click-through presentation.]**

---

## 15. Limitation of Liability

15.1 **Excluded damages.** Except for Excluded Claims (Section 15.3), neither party is liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, revenue, goodwill or data, even if advised of the possibility.

15.2 **Cap.** Except for Excluded Claims, each party's total liability arising out of or relating to this Agreement is limited to [LIABILITY CAP]. **[FOUNDER DECISION: (i) fees paid under the Order giving rise to the claim (current published draft); (ii) fees paid or payable in the 12 months before the claim; (iii) the greater of (ii) or a fixed amount such as $[X]; (iv) a separate, higher cap for data-protection breaches, for example 2x option (ii) or [INSURANCE] limits.]**

15.3 **Excluded Claims.** Sections 15.1 and 15.2 do not limit: (a) Customer's obligation to pay fees; (b) either party's indemnification obligations under Section 16; (c) liability for gross negligence, wilful misconduct or fraud; or (d) liability that cannot be limited by law. **[COUNSEL: Whether indemnities should be uncapped or subject to a super-cap; enforceability of the exclusions against small-business customers.]**

15.4 **Insurance.** Crestmont maintains [INSURANCE]. **[FOUNDER DECISION: Whether to carry professional liability (errors and omissions) and cyber insurance before launch, and at what limits. If none, delete this Section.]**

---

## 16. Indemnification

16.1 **By Crestmont.** Crestmont will defend Customer against a third-party claim alleging that the Deliverables, excluding Customer Content, Third-Party Components and modifications made by others, infringe a U.S. copyright or misappropriate a trade secret. Crestmont will pay damages and costs finally awarded or agreed in settlement. If such a claim arises, Crestmont may modify or replace the affected item, obtain a licence, or (if neither is reasonable) remove the item and refund the fees paid for it.

16.2 **By Customer.** Customer will defend Crestmont against third-party claims arising from: (a) Customer Content; (b) Customer's breach of the AUP or Section 6.1(e); (c) Customer's website, products or services, including content Customer approved for publication; and (d) Customer's failure to give notices or obtain consents required for its website or telephone lines (Schedule C). Customer will pay damages and costs finally awarded or agreed in settlement.

16.3 **Procedure.** The indemnified party must give prompt notice of the claim, give the indemnifying party sole control of the defence and settlement, and provide reasonable cooperation. The indemnifying party may not settle on terms that admit fault on behalf of, or impose obligations on, the indemnified party without consent.

**[COUNSEL: Mutual indemnity scope given Crestmont's size; whether AI-generated content that Customer approved should sit with Customer (as drafted) or be shared; relationship to Section 15.]**

---

## 17. Term and Termination

17.1 **Term.** This Agreement starts when Customer first accepts it and continues until all Orders have ended. Each Maintenance Plan renews as described in Schedule B.

17.2 **Termination for convenience.** Customer may terminate an Order for convenience at any time by notice in the Portal or to [NOTICE EMAIL]. Crestmont may terminate an Order for convenience on [CRESTMONT NOTICE DAYS] days' notice. Fees already paid are then handled under Schedule E. **[FOUNDER DECISION: Whether Crestmont may terminate for convenience at all, and whether a Crestmont-initiated termination always triggers a refund of unearned fees (recommended).]**

17.3 **Termination for cause.** Either party may terminate an Order or this Agreement if the other party materially breaches it and does not cure the breach within [CURE DAYS] days of written notice, or immediately if the other party becomes insolvent. Crestmont may suspend Services immediately for a serious AUP breach as described in the AUP.

17.4 **Effect.** On termination:
(a) Customer pays for work performed and approved milestones up to the termination date, together with approved non-cancellable third-party costs. Refunds are handled under Schedule E;
(b) Crestmont delivers the Deliverables, in their current state, that have been paid for in full, and performs the handover under Section 11.4;
(c) each party returns or deletes the other's Confidential Information, subject to legal retention requirements; and
(d) Customer Data is returned or deleted as stated in the DPA.

17.5 **Survival.** Sections 4 (unpaid amounts), 10, 12, 15, 16, 17.4, 18, 19, 23 and 24 survive termination.

---

## 18. Dispute Resolution

18.1 **Informal negotiation.** Before starting formal proceedings, a party will give written notice of the dispute. Senior representatives will then try in good faith to resolve it for [NEGOTIATION DAYS] days.

18.2 **Formal resolution.** If the dispute is not resolved, it will be resolved by **[FOUNDER DECISION: (i) non-binding mediation, then the state or federal courts in [VENUE COUNTY], [GOVERNING LAW STATE]; (ii) binding individual arbitration under the [AAA Commercial / JAMS] rules seated in [VENUE COUNTY], with a small-claims carve-out; or (iii) courts only.]** **[COUNSEL: Enforceability of arbitration and class-action waiver against small businesses; cost allocation; whether a jury-trial waiver is appropriate if courts are chosen.]**

18.3 **Injunctive relief.** Either party may seek injunctive relief in a court of competent jurisdiction to protect its Confidential Information or intellectual property.

---

## 19. Governing Law

This Agreement is governed by the laws of [GOVERNING LAW STATE], without regard to conflict-of-laws rules. The UN Convention on Contracts for the International Sale of Goods does not apply. **[COUNSEL: Choice of law. Michigan is the likely choice, to be confirmed after entity formation.]**

---

## 20. Force Majeure

Neither party is liable for delay or failure caused by events beyond its reasonable control. Such events include natural disasters, epidemics, war, terrorism, labour disputes, government action, utility or internet failures, and outages of third-party infrastructure (including hosting, payment, email, telephony and AI providers) that are not caused by the affected party. The affected party will give prompt notice and use reasonable efforts to resume performance. This Section does not excuse payment obligations. If a force majeure event continues for more than [FM DAYS] days, either party may terminate the affected Order, and Schedule E applies.

---

## 21. Notices

21.1 **Operational notices.** Routine notices, such as approvals, invoices, reminders and project updates, are given through the Portal and by email to the Customer's account administrator.

21.2 **Legal notices.** Notices of breach, termination, indemnity claims or disputes must be in writing and sent to Crestmont at [NOTICE EMAIL] and [REGISTERED ADDRESS], and to Customer at the email and address of its account administrator in the Portal. Email notices take effect when sent, unless a delivery failure is received. **[COUNSEL: Whether email alone suffices for termination and dispute notices.]**

---

## 22. Assignment and Subcontracting

22.1 Neither party may assign this Agreement without the other's consent. Consent is not needed for an assignment to a successor in a merger or sale of substantially all of the relevant assets, if notice is given.

22.2 Crestmont may use Subprocessors and subcontractors. Crestmont remains responsible for their performance. Subprocessors that process Personal Data are governed by the DPA.

---

## 23. General

23.1 **Entire agreement.** This Agreement, including the Schedules, the DPA and the Orders, is the entire agreement on its subject. It supersedes prior proposals and the published draft documents listed in the header. Customer purchase-order terms do not apply.

23.2 **Amendments.** Crestmont may publish updated versions of this Agreement. An update applies to an existing Order only if Customer accepts it, except for changes required by law or changes to Schedule B entitlements made under Schedule B.6. **[COUNSEL: Unilateral-amendment approach for subscriptions.]**

23.3 **Independent contractors.** The parties are independent contractors.

23.4 **No third-party beneficiaries.** There are no third-party beneficiaries.

23.5 **Severability and waiver.** An unenforceable provision is modified to the minimum extent necessary. A failure to enforce a provision is not a waiver.

23.6 **Publicity.** Neither party uses the other's name or marks publicly except as permitted by Section 10.6 or with consent.

23.7 **Export and sanctions.** Each party complies with applicable export-control and sanctions laws.

---

## 24. Electronic Acceptance and Records

24.1 **Electronic acceptance.** Customer accepts this Agreement, Orders and Change Orders by ticking an explicit acceptance checkbox in the Platform. The checkbox names the documents being accepted. The parties agree that this acceptance is a valid signature. **[COUNSEL: Confirm E-SIGN Act / UETA compliance (including consumer-consent requirements if any buyer is a consumer), and the adequacy of checkbox presentation, scroll and link placement.]**

24.2 **Acceptance Record.** For each acceptance, the Platform stores an Acceptance Record. It contains the exact document version shown, a SHA-256 fingerprint of its text, the accepting user, Customer's organisation, the date and time, the IP address, the browser user agent, and the context (registration, package checkout, Quote acceptance or Maintenance Plan checkout). Document versions and Acceptance Records are immutable: the database rejects changes and deletions. If the text shown differs from the latest stored version, the Platform stores a new version before recording the acceptance.

24.3 **Copies.** Customer may view its accepted versions in the Portal and request a copy at any time. The parties agree that the Acceptance Record is admissible evidence of the terms accepted.

---

# Schedule A — Custom Website Development

A.1 **Application.** This Schedule applies to package Orders and custom Orders for website design and development.

A.2 **Phases.** Projects move through these phases: onboarding, scope review, design, development, internal quality assurance, customer review, revisions, final approval, deployment and completion. The Portal shows the current phase.

A.3 **Onboarding.** Customer completes the onboarding questionnaire and supplies the materials it lists. Work beyond scope review starts once onboarding is submitted.

A.4 **Design milestone.** For custom Orders, Customer's design approval in the Portal triggers the 25% design milestone invoice (Section 4.2(b)).

A.5 **Content.** Packages may include AI-assisted draft copy and appropriately licensed imagery. Draft copy is a starting point that Customer must review for accuracy (Schedule C). Customer supplies final factual information, including prices, credentials, licences, hours and claims.

A.6 **Automated first builds.** When enabled, Crestmont may generate a first build automatically after the first payment is confirmed. Automated builds produce previews only. They never publish to production, change domains, charge Customer or email Customer. Approved or issued refunds, payment disputes and cancellations stop new automated build work.

A.7 **Previews.** Preview sites are for review only. They may be access-restricted and are not covered by Schedule D.

A.8 **Launch and handoff.** Section 8 applies. Final acceptance is recorded in the Portal.

A.9 **Post-launch.** After launch, ongoing hosting, updates and changes are provided under a Maintenance Plan or a new Order. Without a Maintenance Plan, Crestmont has no obligation to host, update or secure the website after handoff, other than under the warranty in Section 14.1. **[FOUNDER DECISION: Whether package prices include a hosting period (for example the first [N] months) or require a Maintenance Plan from launch.]**

---

# Schedule B — Maintenance & Hosting Plans

B.1 **Plans and prices.** Plans are billed monthly in advance. The current prices are Essential $99, Professional $199 and Executive $299 per month.

B.2 **Entitlements.** The entitlements below are **PROPOSED** in the Platform catalog and are **not offered** until approved. Maintenance Plan checkout is disabled in the Platform until approval. **[FOUNDER DECISION: approve, amend or replace each value.]**

| Entitlement | Essential | Professional | Executive |
|---|---|---|---|
| Hosting | [1 site; 10 GB storage / 100 GB transfer] | [1 site; 25 GB / 250 GB] | [up to 2 sites; 50 GB / 500 GB] |
| Maintenance labour (non-rolling) | [1 h/month] | [2.5 h/month] | [4 h/month] |
| Content updates | [2 small updates/month] | [6/month] | [within labour allowance] |
| Security updates | [monthly] | [bi-weekly] | [weekly] |
| Monitoring | [uptime, 5-min interval] | [uptime + performance, 1-min] | [uptime, performance, errors, 1-min] |
| Backups | [weekly, 30-day retention] | [daily, 30-day retention] | [daily, 90-day retention, quarterly restore test] |
| Initial response target | [2 business days] | [1 business day] | [4 staffed hours] |
| Overage rate (prior approval, 30-min increments) | [$95/h] | [$90/h] | [$85/h] |
| Excluded | New pages, new features, redesigns, third-party licence fees | | |

**Note to Founder:** `docs/BACKUP-RECOVERY.md` states that **no automated backups exist yet**. The backup entitlements above cannot be offered until automated backups and a restore drill are in place in production.

B.3 **Version recorded.** The plan version and entitlements in force when Customer subscribes are recorded with the Acceptance Record. **[Platform gap: today the Acceptance Record stores only the plan identifier as context. Entitlements are not part of the accepted agreement text, so a later change to the catalog would not be traceable. Either include the entitlements table in the agreement text, or snapshot it at subscription.]** Unused hours and updates do not carry over. Work beyond the allowance starts only after Customer approves it.

B.4 **Automatic renewal disclosure.** **Each Maintenance Plan renews automatically every month at the then-current price, and Customer's payment method on file is charged, until Customer cancels.** This disclosure is shown next to the acceptance checkbox at checkout. Crestmont sends Customer an email confirmation stating the renewal terms and how to cancel. **[Platform gap: confirm that the `subscription_update` email includes these terms before Maintenance Plans are sold.]**

B.5 **Cancellation online.** Customer may cancel at any time online through the billing section of the Portal, which opens the payment processor's billing portal. No call or email is required. Cancellation takes effect at the end of the current billing period. The current period is not prorated unless required by law (Schedule E.5).

B.6 **Renewal reminders and price changes.** Crestmont will give at least [PRICE NOTICE DAYS] days' notice by email of a price increase or a material reduction in entitlements. Customer may cancel before the change takes effect. **[FOUNDER DECISION: Whether to send periodic renewal reminders, for example annually; and whether to offer annual plans, which some laws require reminders for.]** **[COUNSEL: Applicability of state automatic-renewal laws (for example California, New York, and others) to business customers; Michigan requirements; FTC Negative Option Rule status. The Platform currently has no renewal-reminder or price-change email template.]**

B.7 **Failed payments.** If a renewal payment fails, Crestmont notifies Customer by email. If payment is not made within [GRACE DAYS] days, Crestmont may suspend plan services after further notice. Hosting will not be removed without at least [HOSTING REMOVAL NOTICE DAYS] days' written notice and an opportunity to export under Section 11.5.

B.8 **Requests.** Maintenance requests are submitted through the Portal or a support ticket and handled during [SUPPORT HOURS] under Schedule D.

---

# Schedule C — AI Features & AI Receptionist

C.1 **What AI Features do.** Crestmont uses AI Features to draft content, summarise requests, qualify and route enquiries, draft support replies, and generate first builds. By default, these run on a model hosted on Crestmont-controlled hardware. An optional third-party AI provider (Anthropic) is used only if Crestmont enables it, as listed in DPA Annex 2.

C.2 **Output limitations.** AI output may be inaccurate, incomplete, outdated or similar to existing material. It is a **draft**. Crestmont does not warrant the accuracy of AI output.

C.3 **Human review.** A Crestmont team member reviews AI output before it is sent to Customer or used in a Deliverable. Customer must review all AI-assisted content before approval. **Content that Customer approves, including at Launch Approval, is Customer's responsibility as to accuracy and legality** (Section 16.2(c)).

C.4 **No automated decisions.** AI Features never approve, deny or issue refunds, accept or change contracts, set or change prices, approve releases, or deploy to production. Those actions require an authorised person. The Platform enforces this restriction.

C.5 **AI Receptionist — status and disclosure.** The AI Receptionist is **not yet live**. When it is provided, either for Crestmont's own line or for Customer's line under an Order:
(a) it tells every caller at the start of the call that they are speaking with an AI system;
(b) it asks for consent before recording or transcribing. Without recorded consent, transcripts, recordings and call summaries are discarded;
(c) it quotes only published pricing. It does not discuss refunds, contracts or project status, and it escalates those matters to a person; and
(d) it never confirms whether a caller has an account.

C.6 **Recording consent responsibilities.** For an AI Receptionist on Customer's line, Customer is responsible for deciding which jurisdictions' recording-consent rules apply to its callers. Customer must configure, or instruct Crestmont to configure, the consent script accordingly. Crestmont's default script asks every caller for consent, which is designed to meet all-party-consent requirements. Customer must not instruct Crestmont to record without consent. **[COUNSEL: All-party versus one-party consent states; the Michigan eavesdropping statute's treatment of participant recording; whether an AI agent is a "party"; and whether the default script meets those requirements.]**

C.7 **Inbound only; no telemarketing.** The AI Receptionist answers **inbound** calls only. Crestmont will not place outbound AI or artificial-voice calls or texts for Customer unless the parties sign new written terms, and the required prior express (written) consent has been obtained and documented. **[COUNSEL: TCPA treatment of AI-generated voices as "artificial or prerecorded voice" (FCC 2024 declaratory ruling); state AI-disclosure and bot laws; callback calls made by humans.]**

C.8 **Customer's number and caller compliance.** Customer is responsible for its phone numbers, carrier registration (for example caller-ID and messaging registration where applicable), its own privacy notice for callers, and the lawfulness of the services it advertises on the line.

C.9 **Retention.** Call transcripts and recording links are kept under the retention schedule. The proposed period is 90 days after the call, pending approval (Privacy Policy Section 9).

C.10 **Changes to AI providers.** New AI Subprocessors are added only under the notice process in DPA Section 6.

---

# Schedule D — Service Levels & Support

D.1 **Channels.** Customers can submit support tickets at any time in the Portal and receive an automated acknowledgement with a ticket reference. Automated acknowledgements are not a staff response.

D.2 **Staffed hours.** Support is staffed during [SUPPORT HOURS], excluding [HOLIDAYS]. **[FOUNDER DECISION: hours and time zone.]** Crestmont does not offer 24/7 human support.

D.3 **Response targets.** Initial response targets are goals, not guarantees of resolution time:

| Priority | Definition | Initial response target |
|---|---|---|
| Urgent | Production site down or Security Incident | [URGENT TARGET] staffed hours |
| High | Major feature broken, no workaround | [HIGH TARGET] |
| Normal | Other defects and questions | per plan (Schedule B.2) |
| Low | Requests and changes | [LOW TARGET] |

D.4 **Availability target.** For production websites hosted under a Maintenance Plan, Crestmont targets monthly availability of [UPTIME TARGET], measured by its uptime monitoring. **[FOUNDER DECISION: (i) no numeric target, best efforts only; (ii) 99.5%; (iii) 99.9%. Note that Crestmont depends on Cloudflare's availability and has no automated failover of its own.]**

D.5 **Maintenance windows.** Planned maintenance is performed, where practical, during [MAINTENANCE WINDOW] with [MAINTENANCE NOTICE] notice for planned work expected to cause downtime. Emergency security maintenance may be performed at any time.

D.6 **Service credits.** **[FOUNDER DECISION: (i) no credits; or (ii) credits of [X]% of the monthly plan fee for each [Y] percentage points below target, capped at [Z]% of that month's fee, claimed within 30 days. If credits are offered, they are Customer's sole remedy for missing the availability target.]**

D.7 **Exclusions.** Availability targets exclude planned and emergency maintenance; outages of third-party providers; DNS, registrar or domain problems outside Crestmont's control; Customer-caused issues; AUP suspensions; attacks beyond reasonable mitigation; and preview or staging sites.

D.8 **Business continuity.** Crestmont's backup and recovery procedures are in `docs/BACKUP-RECOVERY.md`. Proposed objectives, which are not yet commitments, are:

| Data | Recovery point objective | Recovery time objective |
|---|---|---|
| Platform database | [RPO — proposed ≤ 24 h] | [RTO — proposed ≤ 4 h] |
| Customer files | [RPO — proposed ≤ 24 h] | [RTO — proposed ≤ 8 h] |
| Application deployment | [proposed 0] | [proposed ≤ 30 min] |

These objectives become commitments only after automated backups exist in production and a restore drill has measured them. Crestmont is a small business. Its continuity plan includes the Founder's documented access to credentials and providers. **[FOUNDER DECISION: key-person contingency, for example a designated backup administrator or escrow of access instructions.]**

D.9 **AI-assisted support.** AI may draft replies and summarise tickets. A person reviews any AI draft before it is sent.

---

# Schedule E — Refunds & Cancellation

E.1 **How to request.** Customer requests a refund in the Portal (Billing) or by support ticket, giving reasons and any supporting information.

E.2 **Decision process.** Every request follows the same process:
(a) Crestmont support staff review the request and record notes, including work delivered and project history. Customer is told that the request is under review;
(b) support either **recommends** the request to Crestmont's owner, or declines a request that is clearly ineligible (a mandatory refund can never be declined at this step);
(c) **only Crestmont's owner (the Founder)** approves or denies a recommended request, and records the reason;
(d) **only the owner** issues an approved refund, through the payment processor to the original payment method; and
(e) Customer is notified in writing of each decision and of issuance.
AI and automated systems never approve, deny or issue refunds.

**[COUNSEL: Should Customer have a route to have a support-level decline reviewed by the owner? The Platform currently allows support staff to deny at review without an owner decision.]**

E.3 **Mandatory refunds.** This Schedule does not limit refund rights under applicable law or payment-card network rules. A refund that is legally required is recorded as a mandatory obligation and cannot be denied.

E.4 **Eligibility guidelines.** **[FOUNDER DECISION: refund percentages and windows. Options to consider:]**

| Situation | Option A (discretionary only) | Option B (stated schedule) |
|---|---|---|
| Package cancelled before onboarding is submitted | Discretionary | [100%] less non-refundable third-party costs, within [N] days of purchase |
| Package cancelled after work starts, before design approval | Discretionary | [50%] |
| Custom deposit, before design approval | Discretionary | Deposit less work performed at [hourly rate] |
| After design approval or Launch Approval | Discretionary | Non-refundable except for non-conformance (Section 14.1) |
| Crestmont terminates for convenience | Unearned fees refunded | Unearned fees refunded |

In all cases, Crestmont considers work completed and approved, third-party costs already incurred (usually non-refundable), and whether the work matched the accepted scope.

E.5 **Maintenance Plans.** Cancellation takes effect at the end of the current billing period. Fees for the current period are not prorated or refunded unless required by law or the cancellation follows a material Crestmont breach. **[FOUNDER DECISION: confirm or allow a pro-rata refund on cancellation.]**

E.6 **Project cancellation.** Customer may request cancellation of a project at any time. A Crestmont owner confirms the cancellation and records the reason; it is never automatic. Section 17.4 and this Schedule then apply.

E.7 **Effect of refund.** An approved or issued refund on an Order stops new automated build work on that Order. On a full refund, Crestmont's licence and assignment obligations under Section 10.2 do not arise for unpaid work. **[COUNSEL: What rights Customer keeps in Deliverables after a partial refund.]**

E.8 **Chargebacks.** If Customer opens a payment dispute, Crestmont may pause work on the affected Order while the dispute is open, and will respond through the payment processor's dispute process.
