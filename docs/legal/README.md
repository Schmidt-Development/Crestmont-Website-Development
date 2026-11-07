# Crestmont Legal Document Suite — Draft v4

> **DRAFT v4 — NOT LEGAL ADVICE — NOT ATTORNEY-REVIEWED — NOT AUTHORIZED FOR PUBLICATION.** The Founder has approved the commercial terms. That approval does not mean an attorney has reviewed these documents, that the open legal questions below are answered, or that publication is authorized. Do not publish these documents, send them to customers or accept payments under them until a separate publication decision is recorded and a new agreement version is stored in the Platform.

Revised 2026-11-07 from Draft v3 (2026-10-28). These files are review drafts and are **not** rendered by the Platform. The published drafts in `src/content/legal.ts` remain live with their "Draft — pending attorney review" banner until a publication decision replaces them. Those drafts are versioned in `migrations/0011_agreements_pricing.sql` and `migrations/0030_legal_drafts_2.sql`. `attorney_reviewed` stays `0` until a qualified attorney's review is actually recorded (LEGAL-004). This revision changed no code, migrations or agreement-version records.

## 1. Status

Five statuses are tracked separately. One never implies another.

| Status | Meaning | Current state (all documents) |
|---|---|---|
| **Founder business approval** | The Founder has approved the commercial terms | **Given.** The legal questionnaire (118 decisions: 111 approved as proposed, plus the seven final decisions 2.9, 2.10, 2.11, 3.6, 3.7, 5.2 and 7.12), decisions FD-01 to FD-47 (`docs/closeout/FOUNDER-DECISIONS-2026-11.md`), and the final closeout answers of 2026-11-07 (§5.3) |
| **Drafting completion** | The text reflects the approved terms and the verified facts | **Complete for final Founder review.** No [CONFIRM] values remain. The **[VERIFY]** items in §6 and the **[COUNSEL]** questions in §7 remain |
| **Independent legal review** | Someone qualified has analysed the open legal questions | **Not performed.** The Founder has not made hiring an attorney a blanket prerequisite (decision 7.12). The **[COUNSEL]** questions in §7 still need an answer before publication |
| **Attorney-reviewed** | A licensed attorney reviewed this text and that review is recorded | **No.** `attorney_reviewed = 0` |
| **Publication authorization** | A recorded decision to publish a specific version | **Not given.** The Founder will authorize a separate publication step only after reviewing these changes and confirming that the required conditions are met |

Markers used in the documents: **[CONFIRM]** marks a fact or value missing from the available record; **[VERIFY]** marks an operational fact to confirm; **[COUNSEL]** marks an open legal question.

## 2. Documents

| File | Purpose | Platform slug / agreement kind | Supersedes on publication |
|---|---|---|---|
| `MASTER-SERVICES-AGREEMENT.md` | The customer contract for all purchased Services. Schedules: A Custom Website Development; B Maintenance & Hosting Plans; C AI Features & AI Receptionist; D Service Levels & Support; E Refunds & Cancellation | New kind proposed: `master_services_agreement` | `development-agreement`, `custom-development-agreement`, `maintenance-agreement` (Schedule B), `support` (Schedule D), `refunds` and `cancellation` (Schedule E); commercial parts of `terms` |
| `DATA-PROCESSING-ADDENDUM.md` | Processor terms for Customer Data; Subprocessor list (Annex 2); security measures (Annex 3) | `data-processing` / `data_processing_addendum` | `data-processing` (2026-10-draft-2) |
| `PRIVACY-POLICY.md` | Crestmont-as-controller notice for visitors, enquirers, callers, prospective customers and Portal users; covers cookies and calls | `privacy` / `privacy_policy` | `privacy` (2026-10-draft-2) |
| `WEBSITE-TERMS-OF-USE.md` | Use of the website and Portal (not purchased Services) | `terms` / `terms_of_service` | Site-use parts of `terms` (2026-10-draft-1) |
| `ACCEPTABLE-USE-POLICY.md` | Prohibited content and conduct, AI misuse, telemarketing, security testing, enforcement | `acceptable-use` / `acceptable_use_policy` | `acceptable-use` (2026-10-draft-1) |
| `ACCESSIBILITY-STATEMENT.md` | **Review copy:** proposed replacement text for the `accessibility` page | `accessibility` (rendered from `src/content/legal.ts`, unchanged) | Current `accessibility` text |
| `BUSINESS-DISCLOSURES.md` | **Review copy:** proposed replacement text for the `disclosures` page | `disclosures` (rendered from `src/content/legal.ts`, unchanged) | Current `disclosures` text |

`RESEARCH-NOTES-2026-10.md` is background research for Draft v3 and is not changed by this revision. Where it conflicts with the decisions in §5, the decisions prevail.

## 3. Terminology (used identically in every document)

| Term | Meaning (full definition in MSA §1) |
|---|---|
| Crestmont | Talent Revenue Systems LLC, trading as Crestmont Website Development |
| Customer | The individual, business or organisation named in an Order as the purchaser. Business registration is not required (decision 5.2) |
| Services | Development, hosting, maintenance, support, AI Features and related services under an Order |
| Deliverables | Work product created specifically for Customer under an Order |
| Customer Content | Materials Customer provides or uploads |
| Customer Data | Data, including Personal Data, that Crestmont processes on Customer's behalf |
| Order / Quote | Package or Maintenance Plan checkout, or an accepted written Quote |
| Statement of Work (SOW) | The scope, line items and assumptions in an accepted Quote |
| Change Order | A written change to scope, price or timeline that Customer approves in the Portal |
| Launch Approval | Customer's recorded Portal approval to deploy to production |
| Maintenance Plan | Monthly hosting and maintenance subscription: Essential $99, Professional $199 or Executive $299 |
| AI Features | Functions that use AI to generate, summarise, classify or route content, including AI-assisted development work |
| AI Receptionist | AI voice agent answering inbound calls. For Customer lines it is not yet available (FD-45) |
| Subprocessor | Third party processing Customer Data (DPA Annex 2) |
| Personal Data | Information relating to an identified or identifiable individual, including "personal information" under applicable law |
| Security Incident | A confirmed breach of security affecting Customer Data |

## 4. Documents considered and not drafted separately

| Document | Where it lives instead | Reason |
|---|---|---|
| Cookie policy | Privacy Policy §6–7 | Only strictly necessary cookies and one first-party attribution cookie (`cm_attr`) are used. There are no third-party analytics or advertising cookies, so no consent banner is needed. **[COUNSEL to confirm]** |
| Business continuity statement | MSA Schedule D.8 | Recovery objectives stay internal until proven (FD-33), so no RPO/RTO figures are published. |
| Security addendum | DPA Annex 3 | The measures are the same, and keeping one list stops the two from drifting apart. |
| Subscription / auto-renewal terms | MSA Schedule B.4–B.7 | Maintenance Plans are the only subscriptions. They are monthly only. |
| Support policy and SLA | MSA Schedule D | Response targets are tied to plan entitlements. |
| Refund and cancellation policies | MSA Schedule E | Refunds follow one process: the Founder decides, and mandatory refunds are never denied (FD-03). Optional: short public summary pages at `/legal/refunds` and `/legal/cancellation` generated from Schedule E. |
| AI usage policy | MSA Schedule C, Privacy §4 and §8, AUP §5 | AI commitments are contractual (Schedule C) or notices (Privacy). |
| Vulnerability disclosure policy | AUP §3(b), §7 | Security and abuse reports go to legal@crestmontwebsitedevelopment.com, with a 1-business-day acknowledgement target. Optional: a short disclosure policy, and `security.txt` pointing to the same address (FD-41). |
| DMCA / copyright policy | AUP §6.3 (counsel question) | Depends on whether Crestmont registers a DMCA agent for hosted sites. |
| SCCs / international transfer addendum | DPA §11 (counsel question) | Not needed unless non-U.S. Customer Data is accepted. |
| Staff/contractor confidentiality agreement | DPA §4.2 | Required before anyone other than the Founder has access (FD-43); it is an internal document outside this customer-facing suite. |

## 5. Founder decisions incorporated

**Source limitation.** The questionnaire itself, with the exact wording of each approved proposal, is not in the repository or in the context of this revision. The 111 approved provisions are therefore preserved by keeping the existing Draft v3 text wherever it was accurate. Values are taken only from the recorded decisions FD-01 to FD-47 and the confirmed business facts. Values that appeared in neither source were marked **[CONFIRM]** rather than guessed; the Founder supplied all of them in the closeout of 2026-11-07 (§5.3). If a questionnaire value differs from an FD value used below, the questionnaire's wording should be checked and the text corrected.

### 5.1 The seven final decisions

| Decision | Where | What changed |
|---|---|---|
| 2.9 Current website workflow | MSA §1.12, Sched. A.2A, A.2B, A.6, E.7 | The customer-facing workflow is: agreed front-end design → back-end build → testing → Launch Approval → deployment. Supplied designs are not guaranteed to convert. "Automated first builds" is removed. No internal tool is a dependency for delivery. |
| 2.10 Technology kept confidential | MSA §4.3, §11.1, Sched. A.2A, C.1, D.4 | Provider and model names are removed. Technology-neutral wording is used. Disclosures that stay are Third-Party Components (§10.4) and Subprocessors (DPA Annex 2). |
| 2.11 AI calling and recording | MSA Sched. C.5, C.6, C.7; Privacy §8; AUP §4(c), §5(b) | No automatic "you are speaking with AI" announcement unless the law requires it. Agents never claim to be human, and answer truthfully when asked. Disclosures, consent and recording notices the law requires always apply. Silence is not consent. The live agents' behaviour is not changed (§8). |
| 3.6 Internal systems kept private | Privacy §2, §3A, §4, §8 | Prospect research, automated calling and call analysis are described by what they do, without system names. AI-assisted processing is stated, not denied. |
| 3.7 Customer-specific vendor information | Privacy §5; DPA Annex 2; MSA §11.1 | The Privacy Policy lists recipient categories, and names are available on request. DPA Annex 2 still names every Subprocessor of Customer Data, as the law and the DPA require. Annex 2 was corrected: Google mail forwarding was added; providers not processing Customer Data were moved to a "not currently engaged" note. |
| 5.2 Open purchasing | MSA §1.2, §2.1, §2.2; Terms §1.2, §2; Privacy §12 | Business-only restrictions are removed. Only capacity (18+, able to contract) and authority to bind someone else remain. A non-waivable-rights clause and consumer-law questions are added. |
| 7.12 Approval without mandatory attorney engagement | Every banner; README §1 | The five statuses are separated. No document claims attorney review, and the open legal requirements are listed in §7. |

### 5.2 Recorded decisions applied to the text

| FD | Applied in |
|---|---|
| 01 Liability cap = amounts paid under the affected Order | MSA §15.2; DPA §12 (no separate data cap). The Website Terms cap is set separately (§5.3) |
| 02 Mediation, then Michigan courts | MSA §18.2, §19 (Michigan law); Terms §13 |
| 03 Founder-only discretionary refunds; support cannot decline | MSA Sched. E.2, E.4 |
| 04 No proration; plans and entitlements established | MSA Sched. E.5, B.1–B.2 (approved wording from the catalog, 2026-11-04) |
| 05 Benefits not certified until tested | MSA Sched. B.2 (†), D.4 |
| 06 99.5% availability target, no restoration deadline | MSA Sched. D.4 |
| 07 No downtime credits | MSA Sched. D.6 |
| 08 Staffed hours Mon–Fri 9–5 ET; no 24/7 implication | MSA Sched. D.2, B.8; AUP §7 |
| 09 48-hour incident notice | DPA §8.1 |
| 10 90-day warranty | MSA §14.1 |
| 11 Net 7; upfront and 50/25/25 unchanged | MSA §4.3 (§3.1, §4.2 unchanged) |
| 12 No late fees or interest | MSA §4.4 |
| 13 Portfolio only with recorded opt-in | MSA §10.6; Terms §6 |
| 14 / 15 Five business days per review; silence never approval | MSA §7.2, §7.5 |
| 16 Founder payment exception | MSA §8.3 |
| 17 30 days to report handoff issues; warranty kept | MSA §8.4 |
| 18 / 19 Resume without automatic fee; never auto-cancel | MSA §9.3, §9.4 |
| 20 No Crestmont termination for convenience | MSA §17.2; Sched. E.4 table removed |
| 21 Customer owns domains; suspension without deletion | MSA §11.2, Sched. B.7 |
| 22 / 36 60-day export window | MSA §11.5; DPA §9.1 |
| 23 No insurance claimed | MSA §15.4 removed |
| 24 Quotes valid 30 days | MSA §3.3 |
| 25 30 days' notice of price increases | MSA Sched. B.6 |
| 26 / 27 Required minimum plan; billing from launch | MSA Sched. A.9, B.2A |
| 33 Recovery numbers internal | MSA Sched. D.8 |
| 35 30 days' notice of Subprocessor changes | DPA §6.3 |
| 37 Backups 35 days daily, 12 months monthly | DPA §9.3; Privacy §9 (not yet in operation) |
| 38 Raw IPs 90 days, security events 180 days (provisional) | Privacy §9 |
| 40 High-risk customers reviewed individually | AUP §2 |
| 41 Security contact / security.txt | AUP §3(b), §7 (contact: legal@, §5.3) |
| 42 Opt-in marketing | Privacy §3 |
| 43 Signed confidentiality before access | DPA §4.2 |
| 45 Customer AI Receptionist "Coming soon" | MSA Sched. C.5; DPA Annex 2 |
| C-1/2 Seven-day failed-payment suspension, no deletion | MSA Sched. B.7 |
| Founder directive 2026-11-06 (MFA removed) | MSA §6.1(f); Terms §3.2; Privacy §2, §13; DPA §4.1, Annex 3 (factual corrections) |

### 5.3 Final closeout answers (2026-11-07)

| Decision | Applied in |
|---|---|
| Talent Revenue Systems LLC, a Michigan LLC, trading as Crestmont Website Development | MSA §1.1; Business Disclosures |
| Mailing address 1409 Lake Lansing Rd, Lansing, MI 48912. It is a mailing address only, not described as a registered office or storefront | MSA §21.2; Privacy §1, §17; Terms §14; Business Disclosures |
| Ingham County, Michigan venue, subject to mandatory law | MSA §18.2; Terms §13 |
| 30-day good-faith resolution period, which is the same period as negotiation before mediation | MSA §4.6, §18.1 |
| Custom revision rounds as stated in each accepted Quote or SOW, with no default | MSA §7.3 |
| Indefinite confidentiality while information stays confidential; disclosure only with authorization or when legally compelled; exclusions kept; legally required retention allowed | MSA §12.2, §12.4, §12.5 |
| 15-day cure period after proper notice | MSA §17.3 |
| 30-day force-majeure termination threshold | MSA §20 |
| Reasonable transition help with no additional Crestmont fee, excluding new development, third-party charges and anything technically impossible | MSA §11.5 |
| Support Mon–Fri 9–5 ET; weekday federal holidays not excluded | MSA Sched. D.2 |
| Response targets: urgent 4 staffed hours, high 1 business day, normal and low 2 business days. A faster plan entitlement prevails | MSA Sched. D.3. The Executive plan (4 staffed hours) and Professional plan (1 business day) are faster than the table and are kept |
| Planned maintenance outside staffed hours where practical, with 24 hours' notice when practical; emergency security work without notice | MSA Sched. D.5 |
| Security and abuse reports to legal@; 1-business-day acknowledgement | AUP §3(b), §7; Business Disclosures |
| Website Terms cap: amounts paid for the affected website services in the prior 12 months, subject to law and non-waivable rights | Terms §10 (the MSA cap is unchanged) |
| Enquiry and prospect retention: 24 months after the last meaningful interaction. Stated as a policy, with the deletion gap disclosed | Privacy §9 |
| Privacy requests answered within 30 days, or sooner if the law requires | Privacy §10.1 |
| Identity verification proportionate to the request | Privacy §11 |
| Prospect sources: Overture Maps and Common Crawl. The pipeline also checks each business's own website, which the policy discloses | Privacy §2, §3A |
| Promotional email allowed once consent, unsubscribe, sender identification and postal address are verified. No campaign enabled | Privacy §3 |
| AI callbacks not disabled; legal requirements reviewed before the Founder decides | Privacy §8 and §7 item 1 below; no code changed |

Corrections beyond the decisions are listed in the change summary of this revision. Examples: the intake comes before payment (MSA §3.4, A.3); the malware-scanning status is stated accurately; read-access logging is limited (DPA §4.1); and unperformed prepaid Services are refunded when an Order ends for force majeure (MSA Sched. E.4A).

## 6. Open items

Every value the Founder was asked for has now been supplied, so no **[CONFIRM]** markers remain. What remains is operational verification (**[VERIFY]**) and the legal questions in §7. Each item is classed as one of:
- **L — legal requirement before publication;**
- **O — operational requirement before a specific feature is enabled or relied on;**
- **R — recommended improvement, not a launch prerequisite.**

| Document and clause | Item | Class | What it blocks | Smallest action |
|---|---|---|---|---|
| Business Disclosures | Michigan certificate of assumed name for "Crestmont Website Development" not confirmed | L | Publishing the disclosures page; trading under the name | Confirm or file with LARA |
| Business Disclosures | Payment processor's required merchant information on the website and checkout | O | Live checkout | Check the processor's requirements |
| DPA Annex 2 | Whether a third-party AI service receives Customer Data in the current workflow; the Google mailbox's account type and data-processing terms; processing locations | L | Publishing the DPA; next customer Order | Confirm each and update Annex 2 |
| Privacy §4; DPA §3.4 | Providers' terms that bar training on call or enquiry content | L | Publishing the Privacy Policy and DPA as written | Check each provider's terms, or soften the statement |
| Accessibility Statement | "Works without JavaScript" claim | L | Publishing the accessibility page with the stronger wording | Test it, or keep the qualified wording |
| MSA Sched. B.2 (†), D.4; DPA §9.3, Annex 3 | Backups, restore tests and monitoring at the stated intervals not yet in operation | O | Selling a Maintenance Plan as including them | Put them in operation, or tell the subscriber they are not yet available, as B.2 requires |
| MSA §7.3 | Custom Quotes have no structured revision-round field | O | Accepting a custom Order | State the revision rounds in each Quote's scope text, or add the field |
| DPA §9.1; MSA §11.5 | Organisation-level data export does not exist (only per-user export) | O | The first Maintenance Plan termination | Build the export, or prepare a manual export procedure |
| DPA §4.2 | Confidentiality agreement (FD-43) not yet written | O | Giving anyone other than the Founder access to Customer Data | Prepare the agreement and have it signed |
| Privacy §3 | No marketing-consent records (FD-42); unsubscribe and suppression already exist | O | Promotional email campaigns | Build consent records and verify sender identification and address |
| Privacy §9 | No automated deletion after 24 months for enquiries and prospect data (disclosed in the policy) | R | Nothing; the policy states the gap | Add a retention job |
| Privacy §2 | Foursquare and OpenStreetMap adapters exist but are off by default | O | Turning either one on | Keep them off, or update Privacy §2 first |
| AUP §3(b) | Optional vulnerability-disclosure page and `security.txt` pointing to legal@ | R | Nothing | Set the security contact setting to legal@ if desired |

## 7. Legal questions (consolidated)

These apply whoever answers them. The Founder's approval of the commercial terms does not answer them. The "When" column uses the same classes as §6.

| # | Question | Where | When |
|---|---|---|---|
| 1 | **AI-voice calls (TCPA)** — see §8.1 for the specific conditions | Privacy §3A, §8; MSA Sched. C.7; AUP §4 | **O** — before the affected calls may proceed |
| 2 | **Recording and real-time processing.** All-party-consent states; Michigan's eavesdropping statute; whether a voice provider's real-time processing is an interception needing consent even when nothing is stored; whether an AI agent or its provider is a "party" | MSA Sched. C.6; Privacy §8 | **O** — before calls are recorded or processed this way; **L** for the accuracy of Privacy §8 |
| 3 | **AI-identity disclosure.** Which federal or state laws require a disclosure at the start of a call without being asked, for Crestmont's lines and for Customer lines | MSA Sched. C.5; Privacy §8 | **O** — before the affected calls |
| 4 | **Consumer buyers (decision 5.2).** Consumer variants for the liability cap and exclusions, disclaimers, dispute resolution and venue, unilateral amendment and refunds; state consumer-protection statutes, including Michigan's; E-SIGN consumer consent for electronic records | MSA §2.2, §14.6, §15, §18, §19, §23.2, §24.1; Terms §10, §13 | **L** |
| 5 | **Recurring billing.** State automatic-renewal laws for business and consumer subscribers; the FTC's ROSCA and negative-option rules; confirmation and reminder emails | MSA Sched. B.4–B.6 | **O** — before Maintenance Plan checkout |
| 6 | **Privacy laws.** Which state privacy laws apply and at what thresholds; service-provider terms; automated-decision and profiling rules for lead research; notice for prospect data gathered from public sources; GPC handling; authorised agents | DPA §1.2, §3.3; Privacy §4, §7, §10.2, §11 | **L** |
| 7 | **Sales tax** on development, hosting and subscriptions | MSA §4.5 | **O** — before live transactions |
| 8 | **Breach notification.** Applicable state laws; whether 48 hours meets the shortest Customer-side deadline | DPA §8.1; Privacy §14 | **R** |
| 9 | **Subprocessor flow-down** wording against standard provider DPAs | DPA §6.2 | **R** |
| 10 | **Enforceability** of the cap, exclusions and indemnities; conspicuous disclaimers; jury waiver; mediation-first requirement | MSA §14.6, §15–16, §18; Terms §9 | **R** — unenforceable terms are severed under MSA §23.5 |
| 11 | **IP:** assignment mechanics, copyright in AI output, open-source and stock licences; rights after a partial refund | MSA §10.2–10.5, Sched. E.7 | **R** |
| 12 | **ADA risk allocation; sensitive data in Customer forms; DMCA agent; amendment by posting; cookie banner; audit rights; international transfers** (the last only if non-U.S. customers are accepted) | MSA §14.5, §23.2; DPA Annex 1, §10.2, §11; AUP §6.3; Terms §14; Privacy §6, §15 | **R** |

## 8. Operating practices that may conflict with a mandatory requirement

These notes describe the documents only. This revision changed no system, and no practice below is described as compliant.

1. **Scheduled AI callbacks.** Per the Founder's decision they are not disabled, pending this legal review. The applicable rules, to be confirmed in §7 item 1, are:
   - **(a) Consent.** Under the TCPA and 47 CFR 64.1200(a)(2)–(3), an AI-generated voice is an "artificial or prerecorded voice". A **telemarketing** call that uses one, to a wireless number or a residential line, needs the called person's **prior express written consent**: a written agreement, which may be signed electronically, that clearly authorizes such calls to that number and states that consent is not a condition of purchase. A sales callback is likely telemarketing. A request made orally during a call is probably prior express consent, but probably **not** prior express *written* consent. Until written consent is captured, AI-voice sales callbacks to those numbers are at risk. A callback placed by a person with a natural voice is outside the artificial-voice rule but still subject to Do-Not-Call rules.
   - **(b) Identification and opt-out.** At the start of the call, the identity of the business. During or after the call, a telephone number. For artificial-voice telemarketing, an automated opt-out (47 CFR 64.1200(b)).
   - **(c) Calling hours and Do-Not-Call.** Calling hours (8 a.m.–9 p.m. recipient time), the internal do-not-call list, and the National Do-Not-Call Registry. An enquiry-based established business relationship does not replace written consent for artificial-voice calls.
   - **(d) Other laws.** State telemarketing, AI-disclosure and recording laws, some stricter than federal law.
2. **Recording consent on Crestmont's own line.** The Platform keeps transcripts and recordings only after consent is recorded. However, the published receptionist prompt does not name the consent function (staging audit, 2026-11-07), so it is unverified whether callers are asked. The voice provider also processes audio in real time either way (§7 item 2).
3. **AI-identity disclosure.** Per decision 2.11, the agents do not announce that they are AI unless the law requires it. Whether a law requires it for these calls is open (§7 item 3). No document states that disclosure is never required.
4. **Security description.** Multi-factor authentication was removed on 2026-11-06. The documents now say so. The published `data-processing` draft in `src/content/legal.ts` still describes MFA as required, and is replaced only at publication.
5. **Promotional email** may be enabled only after consent records (FD-42), unsubscribe handling, sender identification and the postal address are verified in each message.
6. **Maintenance Plan entitlements marked †**, such as backups and monitoring, must not be sold as available until they are confirmed in operation.
7. **Enquiry and prospect retention.** The 24-month policy is not enforced automatically. The Privacy Policy says so instead of promising deletion.

## 9. Implementation notes (engineering, after a publication decision; not part of this revision)

1. Add an agreement kind `master_services_agreement` and add it to `ACCEPTANCE_SETS` (`src/services/agreements.ts`) for `package_checkout`, `quote_acceptance` and `maintenance_checkout`, replacing the kinds it supersedes. Today `refund_policy` is accepted at package checkout but **not** at quote acceptance, and `cancellation_policy` is accepted only at maintenance checkout.
2. Render the approved text, including the two review copies, through `src/content/legal.ts`, and add a new version migration (`scripts/agreement-versions.ts`). Versions are immutable.
3. Replace `DRAFT_BANNER` with a status line that matches the recorded status (§1). It must never say "attorney-reviewed" unless that review is recorded.
