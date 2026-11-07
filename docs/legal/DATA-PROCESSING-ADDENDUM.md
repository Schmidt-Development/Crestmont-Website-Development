# Data Processing Addendum

> **DRAFT v4 — NOT LEGAL ADVICE — NOT ATTORNEY-REVIEWED — NOT AUTHORIZED FOR PUBLICATION.** Status, recorded separately (see `docs/legal/README.md` §1): **Founder business approval** — given for the commercial terms (legal questionnaire and decisions FD-01 to FD-47, 2026-11); **drafting** — complete for Founder review, except the items marked below; **independent legal review** — not performed; **attorney-reviewed** — no (`attorney_reviewed` stays `0`); **publication** — not authorized, and requires a separate recorded decision and a new agreement version in the Platform. Items marked **[CONFIRM]** need a fact or value that is not in the available record. Items marked **[COUNSEL]** are open legal questions: the Founder's approval of the commercial terms does not answer them, and they must be resolved before publication. Items marked **[VERIFY]** need operational confirmation.

**Version:** Draft v4 (revised 2026-11-07; supersedes Draft v3 of 2026-10-28) · **Supersedes (on publication):** published draft `data-processing` (agreement kind `data_processing_addendum`, version `2026-10-draft-2`). Accepted at Quote acceptance, package checkout and Maintenance Plan checkout.

---

## 1. Scope and Definitions

1.1 This Data Processing Addendum ("**DPA**") forms part of the Master Services Agreement ("**Agreement**") between Crestmont and Customer. Capitalised terms have the meanings given in the Agreement, Section 1. In particular, the terms **Crestmont**, **Customer**, **Services**, **Customer Data**, **Personal Data**, **Subprocessor**, **Security Incident**, **AI Features** and **AI Receptionist** are used here exactly as defined there.

1.2 "**Data Protection Law**" means all privacy and data-protection laws that apply to a party's processing of Personal Data under the Agreement. Where they apply, these may include U.S. state consumer-privacy laws, state data-breach notification laws and, if relevant, the EU/UK GDPR. **[COUNSEL: Identify which laws actually apply given Crestmont's size and customer base. Most comprehensive state privacy laws have revenue or volume thresholds that Crestmont may not meet, but its Customers might. Decide whether to include "service provider"/"processor" contract terms required by statutes such as the CCPA/CPRA and the Colorado, Virginia and Connecticut laws as a matter of course.]**

1.3 "**Data Subject**" means the individual to whom Personal Data relates.

1.4 If this DPA conflicts with the Agreement on the processing of Personal Data, this DPA prevails.

## 2. Roles

2.1 **Customer as controller; Crestmont as processor.** Crestmont processes Customer Data as Customer's processor (or "service provider") when it builds, hosts, maintains or supports Customer's website and related Services. This includes data submitted by visitors to Customer's website, content Customer's users place in the Portal, and AI Receptionist call records for Customer's lines. Customer decides the purposes and means of that processing.

2.2 **Crestmont as controller.** Crestmont processes the following as an independent controller (or "business"), under its Privacy Policy and not this DPA: Personal Data about Customer's personnel as account holders, approvers and billing contacts; payment and invoice records; security and audit logs; enquiries made to Crestmont itself; calls to and from Crestmont's own lines; and the business contact data Crestmont uses to find and contact its own potential customers.

2.3 **Customer responsibilities.** Customer is responsible for: having a lawful basis and giving any required notices for the Personal Data its website collects; obtaining consents (including call-recording consent, under Agreement Schedule C.6); and making sure its instructions comply with Data Protection Law.

## 3. Instructions

3.1 Crestmont processes Customer Data only on Customer's documented instructions. The Agreement, the Orders, Customer's configuration of the Services and written requests through the Portal are Customer's complete instructions. Crestmont processes Customer Data otherwise only if the law requires it. In that case Crestmont will inform Customer first, unless the law prohibits doing so.

3.2 Crestmont will tell Customer if, in its opinion, an instruction violates Data Protection Law. Crestmont may then suspend the affected processing.

3.3 Crestmont will not: sell or "share" (for cross-context behavioural advertising) Customer Data; keep, use or disclose it outside the direct business relationship or for any purpose other than the Services; or combine it with Personal Data from other sources, except as Data Protection Law permits for service providers. **[COUNSEL: Confirm the wording against current CCPA/CPRA service-provider requirements, and add a certification if needed.]**

3.4 **AI Features.** Crestmont does not use Customer Data to train AI models. Crestmont gives Customer Data to a third-party AI service only if that service is listed in Annex 2, and only under terms that do not allow the provider to train its models on that data. **[VERIFY: For each third-party AI service, confirm the current commercial terms and data-retention settings before it receives Customer Data.]**

## 4. Confidentiality and Personnel

4.1 Crestmont limits access to Customer Data to personnel who need it to perform the Services. Each person uses an individual account with role-based permissions. Security-relevant and business actions are recorded in the audit log. Not every view of a record is logged.

4.2 Personnel with access are bound by written confidentiality obligations. Crestmont requires a signed confidentiality agreement before anyone other than the Founder is given access to Customer Data. **[CONFIRM: the confidentiality agreement text (Founder decision FD-43) is not yet prepared. Confirm that no one other than the Founder has access to Customer Data until it is signed.]**

## 5. Security

5.1 Crestmont implements and maintains the technical and organisational measures in **Annex 3**. Annex 3 also lists controls that are **not** currently in place.

5.2 Crestmont may update the measures, provided the overall level of protection does not decrease.

## 6. Subprocessors

6.1 **General authorisation.** Customer authorises Crestmont to use the Subprocessors listed in **Annex 2**.

6.2 **Contracts.** Crestmont imposes data-protection obligations on each Subprocessor that are no less protective than this DPA, to the extent applicable to the services that Subprocessor provides. Crestmont remains responsible for its Subprocessors. **[COUNSEL: Most Subprocessors are large providers that offer only standard, non-negotiable DPAs. Confirm that "no less protective" is achievable, or soften the wording to "substantially similar" or "appropriate".]**

6.3 **Notice of changes.** Crestmont will give Customer at least 30 days' notice before adding or replacing a Subprocessor. Notice is given by email to Customer's account administrator and by updating Annex 2 on the Platform.

6.4 **Objection.** Customer may object on reasonable data-protection grounds within the notice period. The parties will discuss the objection in good faith. If they cannot resolve it, Customer may terminate the affected Services and receive a pro-rata refund of prepaid fees for the period after termination.

## 7. Assistance

7.1 **Data Subject requests.** Crestmont will promptly forward to Customer any request it receives from a Data Subject about Customer Data, and will not respond to it except to acknowledge receipt and redirect the requester. Taking into account the nature of the processing, Crestmont will help Customer respond, including by exporting or deleting records. For Customer's own Portal users, the Platform provides self-service data export and a deletion-request workflow at `/account/privacy`.

7.2 **Other assistance.** Crestmont will provide reasonable information to help Customer with data-protection assessments and regulator enquiries about the Services. Assistance that goes beyond making documentation available may be charged at the overage rate in Schedule B, with prior approval.

## 8. Security Incidents

8.1 **Notification.** Crestmont will notify Customer of a Security Incident without undue delay, and in any event within 48 hours after confirming it. **[COUNSEL: Confirm that 48 hours meets the shortest statutory or contractual deadline that may apply to Customers, and that it is achievable outside staffed hours.]**

8.2 **Content.** The notice will describe, as far as known: the nature of the incident; the categories and approximate number of Data Subjects and records affected; likely consequences; and the measures taken or proposed. Crestmont will update Customer as more information becomes available.

8.3 **Cooperation.** Crestmont will take reasonable steps to contain and remediate the incident, and will help Customer meet its notification obligations. Unless the law requires otherwise, Customer decides whether to notify Data Subjects and regulators about Customer Data. Crestmont's notice is not an admission of fault.

8.4 **Unsuccessful attempts.** Unsuccessful attempts that do not compromise Customer Data (for example blocked logins, rate-limited requests or port scans) are not Security Incidents.

## 9. Return and Deletion

9.1 When the Services end, Crestmont will, at Customer's choice, return Customer Data in a commonly used format, or delete it. Customer must make its choice within 60 days after the Services end, matching the transition window in Agreement Section 11.5. After that period Crestmont will delete Customer Data. **[VERIFY: an organisation-level export does not yet exist in the Platform; only per-user export does.]**

9.2 **Exceptions.** Crestmont may keep Customer Data that the law requires it to keep. These records include financial, tax and contractual records, Acceptance Records, and the append-only audit log, which records actions and identifiers but not website form contents. Crestmont keeps such data confidential and processes it only for the purpose of retention.

9.3 **Backups.** Customer Data in backups, including the hosting provider's point-in-time recovery history, is deleted when those backups expire. Until then it is isolated from active use. Crestmont's backup retention periods are 35 days for daily backups and 12 months for monthly backups (Founder decision FD-37). **[VERIFY: automated encrypted backups on that schedule are not yet in operation, and the hosting provider's recovery-history period must be confirmed.]**

9.4 **Customer files.** Files deleted in the Portal are first soft-deleted. Their stored contents are permanently purged after the period in the retention schedule (proposed: 30 days), once that period is switched on.

## 10. Audits

10.1 Crestmont will make available, on request and no more than once a year (or after a Security Incident), information reasonably necessary to show compliance with this DPA. This includes Annex 3, a summary of its security review findings and remediation status, and its Subprocessors' published security reports or certifications.

10.2 Crestmont holds **no** independent security certification and has **not** had an independent penetration test. If Data Protection Law requires an on-site or third-party audit, the parties will agree its scope, timing and cost in advance. Customer bears the cost unless the audit finds material non-compliance. **[COUNSEL: Whether a documentation-only audit right is sufficient for Customers that are subject to GDPR or state laws with audit requirements.]**

## 11. International Transfers

Crestmont is based in the United States. Customer Data is processed in the United States and wherever its Subprocessors operate (Annex 2). **[COUNSEL: Whether Crestmont will accept non-U.S. Customers or knowingly process EU/UK Personal Data. If it will, add EU SCCs / UK Addendum (or reliance on the EU–U.S. Data Privacy Framework through Subprocessors), and assess Cloudflare's global edge processing. If it will not, state that the Services are not offered for EU/UK Personal Data.]**

## 12. Liability

Each party's liability under this DPA is subject to the limitations in Agreement Section 15. There is no separate data-protection cap.

## 13. Term

This DPA lasts as long as Crestmont processes Customer Data under the Agreement.

---

## Annex 1 — Description of Processing

| Item | Description |
|---|---|
| Subject matter | Providing the Services under the Agreement |
| Duration | The term of the Agreement, plus the return and deletion period in Section 9 |
| Nature of processing | Collection through Customer websites and the Portal; storage; hosting; transmission (email notifications); organisation; retrieval; AI-assisted drafting, summarisation and development work; deletion |
| Purpose | Building, hosting, maintaining and supporting Customer's website; operating the Portal; answering calls with the AI Receptionist where ordered; support |
| Categories of Data Subjects | Visitors to Customer's website and people who submit its forms; Customer's customers and prospects; Customer's staff using the Portal; callers to Customer's lines (AI Receptionist) |
| Categories of Personal Data | Contact details (name, email, phone, company); form-submission content; messages and files in the Portal; for AI Receptionist calls: phone number, call metadata, outcome and, **only with consent**, transcript, recording link and summary; technical data (IP address, user agent) in security logs |
| Special categories / sensitive data | Not intended. Customer must not configure forms to collect government ID numbers, financial account numbers, health data or children's data without a written Order addressing it. **[COUNSEL: Whether to prohibit outright or allow with additional terms.]** |
| Retention | Under Section 9 and `docs/RETENTION-SCHEDULE.md`. Proposed configurable periods are pending approval, including 90 days for call transcripts and 30 days for purging soft-deleted files |

## Annex 2 — Subprocessors

| Subprocessor | Purpose | Customer Data involved | Processing location |
|---|---|---|---|
| Cloudflare, Inc. | Application hosting (Workers), database (D1), private file storage (R2), CDN, network security and email routing | All Customer Data stored in the Platform and hosted websites | United States and global edge network [VERIFY: D1/R2 location hints or jurisdiction settings] |
| Stripe, Inc. | Payment processing, subscriptions, invoices, refunds, billing portal | Billing contact name and email, payment details (held by Stripe; Crestmont receives only limited card details) | United States [VERIFY] |
| Resend (Plus Five Five, Inc.) | Transactional email delivery | Recipient name and email, email content (project updates, invoices, notifications) | United States [VERIFY] |
| Google LLC (email) | Receives email sent to Crestmont's addresses, which are forwarded to a Google mailbox | Any Customer Data that Customer or its users send by email | [VERIFY] |
| GitHub, Inc. (Microsoft) | Source-code hosting for the Platform and Customer website repositories | Website source code and content committed to it. No Customer Data from forms or the Portal is expected | United States [VERIFY] |

**Not currently engaged for Customer Data.** A voice provider for an AI Receptionist on Customer's own line (not yet available, Agreement Schedule C.5), any third-party AI service, and any off-site backup, monitoring or error-tracking provider will be added to this Annex under Section 6.3 before they process Customer Data. **[VERIFY: (a) whether any third-party AI service receives Customer Data in the current development workflow; if one does, it must be listed here before the next Order; (b) that no other provider processes Customer Data; (c) whether the Google mailbox is a consumer Gmail account, whose terms may not include data-processing commitments, or a business account with them.]** Processing on systems that Crestmont itself controls is not a Subprocessor.

## Annex 3 — Technical and Organisational Security Measures

These are the controls **implemented in the Platform** as at this draft. Where a control depends on production infrastructure that is not yet provisioned, this is noted.

**Access control and authentication**
- Passwords are hashed with PBKDF2-HMAC-SHA256 (100,000 iterations, 16-byte random salt). Plain-text passwords are never stored.
- Repeated failed logins trigger progressive protections (a bot challenge for unrecognised devices and failed-attempt rate limits) rather than a fixed account lockout, and authentication endpoints are rate limited.
- Role-based access control separates staff roles (owner, administrator, sales, developer, project manager, support) and customer roles (customer admin, customer member). Refund decisions, pricing changes and production release approval are restricted to the owner.
- AI actors are technically prevented from performing refund, contract, pricing or release actions.

**Tenant isolation and files**
- Customer data is scoped to the Customer's organisation. Customer users can access only their own organisation's records.
- Files are stored in private object storage. Every download passes through an authorised endpoint that checks access and writes an audit entry.
- Each file has a malware-scan status. A file that a scan flags is quarantined and cannot be downloaded. Sharing a file that has not been scanned requires an explicit acknowledgement.
- Share links are time-limited (maximum 7 days) and revocable. They store only a hash of the token, and every access is rate limited and audited.

**Logging and integrity**
- An append-only audit log records security-relevant and business actions. Database triggers prevent updates and deletions.
- Agreement versions and Acceptance Records are immutable.

**Transmission and application security**
- All traffic uses encryption in transit (HTTPS, with HSTS).
- Security headers include a restrictive Content Security Policy and frame denial. CSRF protection is applied to state-changing requests.

**Retention and backups**
- A daily retention job deletes expired sessions, rate-limit counters and used or expired tokens. Additional retention periods are configurable and will be switched on once approved.
- Backup and restore procedures are documented, and restore drills are recorded. **Automated encrypted production backups are not yet in operation.** [VERIFY]

**Privacy operations**
- Users can export their personal data themselves. Deletion requests are processed by staff and anonymise the user while keeping legally required records.

**Not currently in place** (Customer should take these into account):
- **No multi-factor authentication.** Sign-in for Crestmont staff and Customer users is by password, protected by the rate limits and bot challenge above. There is no step-up re-authentication for sensitive actions; those actions are restricted by role.
- **Malware scanning is not confirmed in production.** Files are scanned only when a scanning service is connected. Until then they are labelled "not yet scanned". [VERIFY]
- **Logging of read access is limited.** Not every staff view of a Customer record is logged.
- **No independent penetration test** has been performed. An internal ASVS-based review has been carried out.
- **No security certification** (for example SOC 2 or ISO 27001).
- **No automated production backups or off-site backup copy yet.**
- Encryption at rest of the database and files relies on the hosting provider's platform encryption [VERIFY with Cloudflare documentation]. There is no additional application-level encryption.
