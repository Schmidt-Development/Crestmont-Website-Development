# Crestmont Legal Document Suite — Draft v3

> **DRAFT v3 — NOT LEGAL ADVICE — NOT APPROVED FOR USE.** Prepared for review by a licensed attorney. Placeholders in [BRACKETS] must be completed. Items marked **[FOUNDER DECISION]** need a business decision; items marked **[COUNSEL]** need legal analysis. Do not publish, send to customers, or accept payments under this text until counsel has approved it and a new agreement version is recorded in the platform.

Prepared 2026-10-28. These files are review drafts. They are **not** rendered by the Platform. The published drafts in `src/content/legal.ts`, which are versioned in `migrations/0011_agreements_pricing.sql` and `migrations/0030_legal_drafts_2.sql`, remain live with their "Draft — pending attorney review" banner until counsel approves replacements. `attorney_reviewed` stays `0` until a real review is recorded (LEGAL-004).

## 1. Documents

Status of every document: **Draft v3 — awaiting Founder decisions and attorney review.**

| File | Purpose | Platform slug / agreement kind | Supersedes (published draft) |
|---|---|---|---|
| `MASTER-SERVICES-AGREEMENT.md` | The customer contract for all purchased Services. Schedules: A Custom Website Development; B Maintenance & Hosting Plans; C AI Features & AI Receptionist; D Service Levels & Support; E Refunds & Cancellation | New kind proposed: `master_services_agreement` | `development-agreement`, `custom-development-agreement`, `maintenance-agreement` (Schedule B), `support` (Schedule D), `refunds` and `cancellation` (Schedule E); commercial parts of `terms` |
| `DATA-PROCESSING-ADDENDUM.md` | Processor terms for Customer Data; Subprocessor list; security measures | `data-processing` / `data_processing_addendum` | `data-processing` (2026-10-draft-2) |
| `PRIVACY-POLICY.md` | Crestmont-as-controller notice for visitors, enquirers and Portal users; covers cookies and calls | `privacy` / `privacy_policy` | `privacy` (2026-10-draft-2) |
| `WEBSITE-TERMS-OF-USE.md` | Use of the website and Portal (not purchased Services) | `terms` / `terms_of_service` | Site-use parts of `terms` (2026-10-draft-1) |
| `ACCEPTABLE-USE-POLICY.md` | Prohibited content and conduct, AI misuse, telemarketing, security testing, enforcement | `acceptable-use` / `acceptable_use_policy` | `acceptable-use` (2026-10-draft-1) |

**Not changed by this suite:** `accessibility` (accessibility statement) and `disclosures` (business disclosures). Disclosures must be updated with [LEGAL ENTITY NAME] and [REGISTERED ADDRESS] when those are known.

## 2. Terminology (used identically in every document)

| Term | Meaning (full definition in MSA §1) |
|---|---|
| Crestmont | [LEGAL ENTITY NAME], trading as Crestmont Website Development |
| Customer | The business named in an Order |
| Services | Development, hosting, maintenance, support, AI Features and related services under an Order |
| Deliverables | Work product created specifically for Customer under an Order |
| Customer Content | Materials Customer provides or uploads |
| Customer Data | Data, including Personal Data, that Crestmont processes on Customer's behalf |
| Order / Quote | Package or Maintenance Plan checkout, or an accepted written Quote |
| Statement of Work (SOW) | The scope, line items and assumptions in an accepted Quote |
| Change Order | A written change to scope, price or timeline that Customer approves in the Portal |
| Launch Approval | Customer's recorded Portal approval to deploy to production |
| Maintenance Plan | Monthly hosting and maintenance subscription (Essential, Professional or Executive) |
| AI Features | Functions that use AI to generate, summarise, classify or route content, including automated first builds |
| AI Receptionist | AI voice agent answering inbound calls (not yet live) |
| Subprocessor | Third party processing Customer Data (DPA Annex 2) |
| Personal Data | Information relating to an identified or identifiable individual, including "personal information" under applicable law |
| Security Incident | A confirmed breach of security affecting Customer Data |

## 3. Documents considered and not drafted separately

| Document | Where it lives instead | Reason |
|---|---|---|
| Cookie policy | Privacy Policy §6–7 | Only strictly necessary cookies and one first-party attribution cookie (`cm_attr`) are used. There are no third-party analytics or advertising cookies, so no consent banner is needed. **[COUNSEL to confirm]** |
| Business continuity / disaster recovery statement | MSA Schedule D.8 | The RPO/RTO figures are proposals in `docs/BACKUP-RECOVERY.md`, not commitments. One schedule avoids promising them twice. |
| Security addendum | DPA Annex 3 | The measures are the same, and keeping one list stops the two from drifting apart. |
| Subscription / auto-renewal terms | MSA Schedule B.4–B.7 | Maintenance Plans are the only subscriptions. |
| Support policy and SLA | MSA Schedule D | Response targets are tied to plan entitlements. |
| Refund and cancellation policies | MSA Schedule E | These policies must follow the Platform's single refund decision process. **[FOUNDER DECISION]** Whether to keep short public summary pages at `/legal/refunds` and `/legal/cancellation` generated from Schedule E. |
| AI usage policy | MSA Schedule C, Privacy §4, AUP §5 | AI commitments are contractual (Schedule C) or notices (Privacy). |
| Vulnerability disclosure policy | AUP §3(b) (placeholder) | A short standalone page plus `security.txt` is recommended later. It is listed as a Founder decision. |
| DMCA / copyright policy | AUP §6.3 (counsel question) | Depends on whether Crestmont registers a DMCA agent for hosted sites. |
| SCCs / international transfer addendum | DPA §11 (counsel question) | Not needed unless non-U.S. Customer Data is accepted. |
| Staff/contractor NDA | DPA §4.2 (Founder decision) | Internal document, outside this customer-facing suite. |

## 4. Implementation notes (for engineering after approval)

1. Add an agreement kind `master_services_agreement` and add it to `ACCEPTANCE_SETS` (`src/services/agreements.ts`) for `package_checkout`, `quote_acceptance` and `maintenance_checkout`, replacing the kinds it supersedes. Today `refund_policy` is accepted at package checkout but **not** at quote acceptance, and `cancellation_policy` is accepted only at maintenance checkout.
2. Render the approved text through `src/content/legal.ts`, and add a new version migration (`scripts/agreement-versions.ts`). Versions are immutable.
3. Keep `DRAFT_BANNER` until counsel approval is recorded.

## 5. Founder decisions (consolidated)

1. Liability cap option — MSA §15.2; DPA §12; Terms §10
2. Dispute resolution (mediation + courts / arbitration / courts only) — MSA §18.2; Terms §13
3. Refund percentages and windows — MSA Sched. E.4; Maintenance proration — E.5
4. Maintenance Plan entitlements (each value) — MSA Sched. B.2
5. Uptime target and service credits — MSA Sched. D.4, D.6
6. Support hours, response targets, maintenance windows — MSA Sched. D.2–D.5
7. Security Incident notification window — DPA §8.1
8. Warranty period — MSA §14.1
9. Late fees and payment terms — MSA §4.3–4.4
10. Portfolio consent model — MSA §10.6
11. Deemed approval (recommended: none) — MSA §7.5; review period — §7.2
12. Owner payment exception before launch — MSA §8.3; handoff acceptance window — §8.4
13. Closing long-paused projects; restart lead time — MSA §9.3–9.4
14. Crestmont termination for convenience — MSA §17.2
15. Domain registrar ownership model — MSA §11.2; transition window — §11.5; DPA §9.1
16. Hosting included after launch or plan required — MSA Sched. A.9
17. Insurance (E&O, cyber) — MSA §15.4
18. Quote validity — MSA §3.3
19. Renewal reminders and price-change notice — MSA Sched. B.6
20. Subprocessor notice period; off-site backup provider — DPA §6.3, Annex 2
21. Backup and retention periods; enquiry retention — DPA §9.3; Privacy §9
22. Key-person continuity — MSA Sched. D.8
23. High-risk business categories — AUP §2; vulnerability disclosure policy — AUP §3(b)
24. Marketing email — Privacy §3
25. Staff confidentiality agreement — DPA §4.2

## 6. Questions for counsel (consolidated)

1. Entity details, governing law and venue (Michigan is the likely choice, to be confirmed) — MSA §1.1, §19
2. Business-only status; consumer buyers; E-SIGN/UETA adequacy of checkbox acceptance — MSA §2.1, §24.1
3. Enforceability of the liability cap, exclusions and indemnity scope — MSA §15–16
4. Arbitration and class waiver or jury waiver — MSA §18.2
5. Automatic-renewal laws (state and FTC) for business subscribers — MSA Sched. B.6
6. Call-recording consent (Michigan and all-party states); AI as a "party"; TCPA treatment of AI voice; state bot-disclosure laws — MSA Sched. C.6–C.7; Privacy §8
7. Applicability of state privacy laws and thresholds; service-provider contract terms — DPA §1.2, §3.3; Privacy §10.2
8. International transfers / non-U.S. Customers — DPA §11; Privacy §15
9. Breach notification law(s) and the DPA window — DPA §8.1; Privacy §14
10. Sales tax on development, hosting and subscriptions — MSA §4.5
11. IP assignment mechanics; copyrightability of AI output; open-source and stock licences — MSA §10.2–10.5
12. Late-fee limits — MSA §4.4
13. Disclaimer conspicuousness — MSA §14.6; Terms §9
14. ADA / accessibility risk allocation — MSA §14.5
15. Support-level refund declines without owner review — MSA Sched. E.2
16. Rights in Deliverables after a partial refund — MSA Sched. E.7
17. Documentation-only audit right — DPA §10.2
18. Subprocessor flow-down wording — DPA §6.2
19. Sensitive data in Customer forms — DPA Annex 1
20. GPC handling of campaign parameters — Privacy §7; automated-decision rules for lead qualification — Privacy §4
21. DMCA agent and takedown process — AUP §6.3
22. Amendment by posting versus re-acceptance — MSA §23.2; Terms §14
23. Email sufficiency for legal notices — MSA §21.2
