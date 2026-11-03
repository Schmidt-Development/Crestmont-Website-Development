# A-J failure-mode coverage

Shared safeguards, not 231 separate systems: each failure mode is covered by one of the mechanisms in `safeguards`, and a row leaves OPEN only when a named test in THIS repository proves that mechanism catches it.

- OPEN means not investigated in this repository yet. It does not mean the failure cannot happen, and it does not mean it is uncovered.
- The gates A-J are implemented in runner/starters/fullstack-v1/scripts/gates.mjs, not in runner/src, which is why they are easy to miss when reading the runner. Mapping the remaining rows means reading that script against each row; that is the next step and it has not been taken.
- Five rows the source inventory recorded as verified cited test files that did not exist here. Two (E03, E04) were already covered by differently-named tests and have been re-cited. Three (F15, F16, F20) depended on a quality ratchet that was genuinely absent; the ratchet rule and the git restore it needs have since been brought in and wired into the cycle loop, driven by the quality scorecard this runner already computes so no second notion of quality is introduced alongside it.

Generated 2026-11-03T05:27:13.782Z from 246 failure modes.

| status | rows |
| --- | --- |
| OPEN | 224 |
| FIXED_AND_VERIFIED | 14 |
| EXISTING_AND_VERIFIED | 6 |
| BLOCKED_ON_AUTHORIZATION | 2 |

## Cited tests that are failing in this repository

### `runner/test/fullstack.test.ts [AIB-QUALITY] ... [fake model, fake docker]`

Bears on: S1, S2, S7 (PRE_EXISTING_FAILURE)

Three end-to-end tests ('a verified 10/10 ... completes as ready_for_review', 'a score below 10 can never enter internal approval', 'only a provider-side verification missing') fail with "Acceptance checks failed: quality-gates, brief-conformance". Identical on the pristine baseline, so not a regression. Every gate test that runs the real gates against a fixture website passes, including all four cross-industry package runs, so what is unproven is the fake-model end-to-end wiring rather than the scorecard rules or the gates.

### `runner/test/resilience.test.ts [AIB-RUNNER] checkpoints never carry links`

Bears on: S14 (PRE_EXISTING_FAILURE)

Asserts that symlinks are left out when a checkpoint is built and that an archive containing links is refused on restore. It fails on this machine with EPERM creating a symlink at C:etcpasswd, which needs elevation, identically on the pristine baseline. The refusal-on-restore half is what matters for safety and is not what fails; the test cannot set up its fixture without an elevated shell.

## Shared safeguards

**S1. Quality scorecard (20 criteria; a verified 10/10 is required before internal approval)**

- Where: runner/src/quality.ts, enforced by the platform at approval
- Proven by: `runner/test/fullstack.test.ts [AIB-QUALITY] (the scorecard rules themselves); tests/builds-v2.test.ts [AIB-QUALITY] (platform enforcement at approval)`

**S2. Acceptance gates A-J, and website code that cannot forge them**

- Where: the starter's acceptance commands; results in .crestmont/quality/gates.json, trusted only when the runner's own quality-gates check ran this cycle and its bytes match that command's single digest
- Proven by: `runner/test/fullstack.test.ts [AIB-V2]`

**S3. Cross-file contract check (element ids, form fields, endpoint paths)**

- Where: runner/src/contracts-check.ts
- Proven by: `runner/test/contracts-check.test.ts [CONTRACT]`

**S4. Headless browser check: EVERY .html page under the site root x desktop and mobile (console errors, failed requests, horizontal overflow, nav landmark, screenshots)**

- Where: runner/sandbox/browser-check.mjs
- Proven by: `runner/test/browser-check.test.ts [AIB-RUNNER]`

**S5. Persistence check: a success claim must be backed by a durable write**

- Where: runner/src/checks.ts
- Proven by: `runner/test/durability.test.ts`

**S6. Credential scan: no credentials or local secret files in the website's source**

- Where: runner/src/checks.ts credentialScan
- Proven by: `runner/test/exec-security.test.ts`

**S7. Brief conformance: the customer's own business details appear on the site**

- Where: runner/src/checks.ts briefConformance
- Proven by: `runner/test/job.test.ts`

**S8. Sandbox isolation verified by docker inspect (no network, read-only root, no capabilities, non-root, only the job's mounts)**

- Where: runner/src/checks.ts isolationCheck
- Proven by: `runner/test/isolation.test.ts`

**S9. Independent review session (Model A with vision); a verdict is 'unsupported' unless the reviewer actually saw desktop AND mobile screenshots**

- Where: runner/src/orchestrator/advisors.ts, runner/src/quality.ts
- Proven by: `runner/test/orchestrator.test.ts; runner/test/fullstack.test.ts [AIB-QUALITY]`

**S10. Acceptance evidence record: missing evidence is reported as missing, never as a failing website, and the runner never supplies a status itself**

- Where: runner/src/orchestrator/evidence.ts missingCriteriaEvidence
- Proven by: `runner/test/acceptance-evidence.test.ts [AIB-EVIDENCE]`

**S11. Requirement integrity: 'verified' needs evidence, that evidence survives the round-trip through the platform, and the checks that just ran outrank the claim seed**

- Where: runner/src/requirements.ts, src/services/builds.ts claim
- Proven by: `runner/test/report.test.ts [AIB-REQ-EVIDENCE]; tests/builds.test.ts [AIB-REQ-EVIDENCE]`

**S12. Bounded repair loop (cycle limit, repeated failure signature, no measurable progress, ineffective-repair guard), and an overrule that carries its own corrective prompt**

- Where: src/services/build-pipeline.ts submitCycle, runner/src/job.ts
- Proven by: `tests/builds-v2.test.ts [AIB-013], [AIB-OVERRULE]`

**S13. pending_external: a customer-owned service is never recorded as live; the build waits for the customer instead of faking it**

- Where: runner/src/quality.ts, src/services/build-pipeline.ts
- Proven by: `tests/builds-v2.test.ts [AIB-013]`

**S15. Repair ratchet: the best revision is kept, a repair that measurably loses ground is reverted to it, and repeated regressions stop the loop**

- Where: runner/src/orchestrator/ratchet.ts, runner/src/git.ts restoreTo, wired into the cycle loop in runner/src/job.ts
- Proven by: `runner/test/quality-ratchet.test.ts [RATCHET]`

**S14. Segment continuation: a per-segment limit ends a segment, not the build; 'released' requeues without spending an attempt and resumes from the checkpoint**

- Where: runner/src/job.ts, src/services/builds.ts
- Proven by: `tests/builds.test.ts [AIB-004] (the platform half); runner/test/continuity.test.ts [AIB-CONTINUITY] (the archive half: built and restored from a drive-letter path); runner/test/orchestrator.test.ts [AIB-015] (checkpointed and released without spending an attempt)`

## Rows that are not OPEN

| id | failure mode | status | safeguards | proven by |
| --- | --- | --- | --- | --- |
| A12 | Fabricated testimonials | EXISTING_AND_VERIFIED | - | runner/test/orchestrator.test.ts |
| A24 | Requirements incorrectly marked complete | FIXED_AND_VERIFIED | S11, S1 | runner/test/report.test.ts [AIB-REQ-EVIDENCE]; tests/builds.test.ts [AIB-REQ-EVIDENCE]; runner/test/fullstack.test.ts [AIB-QUALITY] (the scorecard rules themselves); tests/builds-v2.test.ts [AIB-QUALITY] (platform enforcement at approval) |
| A25 | Missing traceability from requirement to implementation and test | FIXED_AND_VERIFIED | S10, S2 | runner/test/acceptance-evidence.test.ts [AIB-EVIDENCE]; runner/test/fullstack.test.ts [AIB-V2] |
| B01 | HTML and JavaScript element ID mismatches | FIXED_AND_VERIFIED | - | runner/test/contracts-check.test.ts |
| B02 | Frontend/backend field mismatches | FIXED_AND_VERIFIED | - | runner/test/contracts-check.test.ts |
| B10 | Broken forms | FIXED_AND_VERIFIED | - | Verified against real repos in-container. |
| B11 | Missing backend endpoints | FIXED_AND_VERIFIED | - | runner/test/contracts-check.test.ts |
| B30 | Premature completion claims | EXISTING_AND_VERIFIED | S1, S12, S10 | runner/test/fullstack.test.ts [AIB-QUALITY] (the scorecard rules themselves); tests/builds-v2.test.ts [AIB-QUALITY] (platform enforcement at approval); tests/builds-v2.test.ts [AIB-013], [AIB-OVERRULE]; runner/test/acceptance-evidence.test.ts [AIB-EVIDENCE] |
| E02 | Screenshot focus artifacts | FIXED_AND_VERIFIED | - | Verified by capturing clean screenshots of run 1. |
| E03 | Missing internal-page review | EXISTING_AND_VERIFIED | S4 | runner/test/browser-check.test.ts [AIB-RUNNER] |
| E04 | Missing mobile review | EXISTING_AND_VERIFIED | S4, S9 | runner/test/browser-check.test.ts [AIB-RUNNER]; runner/test/orchestrator.test.ts; runner/test/fullstack.test.ts [AIB-QUALITY] |
| E09 | Vague repair instructions | FIXED_AND_VERIFIED | S12 | tests/builds-v2.test.ts [AIB-013], [AIB-OVERRULE] |
| E12 | Overly generous scores | EXISTING_AND_VERIFIED | - | runner/test/orchestrator.test.ts |
| E20 | Reviewer treating subjective scores as objective market valuations | FIXED_AND_VERIFIED | - | runner/test/orchestrator.test.ts |
| F15 | Continuing despite repeated degradation | FIXED_AND_VERIFIED | S15 | runner/test/quality-ratchet.test.ts [RATCHET] |
| F16 | Missing safe rollback | FIXED_AND_VERIFIED | S15 | runner/test/quality-ratchet.test.ts [RATCHET] |
| F20 | Failure to preserve previously certified functionality | FIXED_AND_VERIFIED | S15 | runner/test/quality-ratchet.test.ts [RATCHET] |
| G03 | Vision model missing screenshots | EXISTING_AND_VERIFIED | - | runner/test/orchestrator.test.ts |
| G15 | Broken checkpoint restoration | FIXED_AND_VERIFIED | S14 | tests/builds.test.ts [AIB-004] (the platform half); runner/test/continuity.test.ts [AIB-CONTINUITY] (the archive half: built and restored from a drive-letter path); runner/test/orchestrator.test.ts [AIB-015] (checkpointed and released without spending an attempt) |
| G16 | Failed resume behavior | FIXED_AND_VERIFIED | S14, S11 | tests/builds.test.ts [AIB-004] (the platform half); runner/test/continuity.test.ts [AIB-CONTINUITY] (the archive half: built and restored from a drive-letter path); runner/test/orchestrator.test.ts [AIB-015] (checkpointed and released without spending an attempt); runner/test/report.test.ts [AIB-REQ-EVIDENCE]; tests/builds.test.ts [AIB-REQ-EVIDENCE] |
| G18 | Runner/harness version mismatch | BLOCKED_ON_AUTHORIZATION | - | none in this repository |
| G19 | Local versus installed-runner behavioral differences | BLOCKED_ON_AUTHORIZATION | - | none in this repository |

### Why

**A24 Requirements incorrectly marked complete**

A requirement could be marked verified without evidence; and -- the defect found in run 5 -- the evidence was dropped by the claim query, so from the second segment on the runner's own PASSING checks came back unevidenced and were downgraded to unverified.

Both directions are closed: a claim of 'verified' still needs evidence, and real evidence now survives the round-trip so a genuine verification is not re-judged as a bare claim.

**A25 Missing traceability from requirement to implementation and test**

Nothing distinguished an acceptance criterion that FAILED from one with no recorded status, so four consecutive builds were repaired against criteria that were never failing, while the scorecard could not rise above about a third however good the website was.

A missing .crestmont/acceptance.json is now reported as missing evidence, naming the file, the shape and the criteria still unrecorded. The runner never writes a status itself: an invented one would be exactly the fabricated verification the quality engine exists to prevent.

**B30 Premature completion claims**

A premature 'ready' is overruled against the evidence, and no build reaches internal approval without a verified 10/10. Verified here by running those tests, which pass.

**E03 Missing internal-page review**

Reviewing only the home page.

The browser check walks every .html page under the site root recursively, not just the home page: run 5 reported 22/22 page views over 11 pages. The inventory cited runner/test/review-isolation.test.ts, which does not exist here; the real proof is the browser-check test.

**E04 Missing mobile review**

No mobile review.

A desktop-only run leaves the 'mobile' criterion unsupported and outstanding, and a reviewer that saw no screenshots cannot pass a visual criterion. The inventory cited runner/test/quality.test.ts, which does not exist here; the real proof is fullstack.test.ts [AIB-QUALITY].

**E09 Vague repair instructions**

The reviewer contract says nextPrompt is null for any decision that is not a continuation. When the platform overruled such a decision into a continuation there was no prompt, so it escalated the build instead of naming the work -- blaming the reviewer for an omission it had never been asked to fill.

An overrule now writes the prompt from the outstanding items it just named. The loop bounds are unchanged: [AIB-013] still escalates after three identical cycles.

**F15 Continuing despite repeated degradation**

The loop continued after repeated degradation.

The ratchet stops the loop after two repairs in a row that lower the score, instead of spending more GPU time on a loop that is not converging.

**F16 Missing safe rollback**

Repairs were kept unconditionally. Measured decline 7.50 -> 7.16 -> 7.22 -> 6.94; the build could only walk away from its own best work and the LAST state was what the customer would receive.

restoreTo puts the working tree back to the best revision as a NEW commit, so the failed attempt stays in the log as evidence -- what `reset --hard` would have discarded. A file a bad repair ADDED is removed too, which `checkout -- .` leaves behind.

**F20 Failure to preserve previously certified functionality**

Visual repairs destroyed previously working state with no way back.

The best measured revision is recorded and restored, so a build can no longer walk away from its own best work. Measured on Node 1 (2026-11-02): 7.50 -> 7.16 -> 7.22 -> 6.94, every repair kept whatever it did, so the worst state was the deliverable. Driven by the quality scorecard this runner already computes, so no second notion of quality is introduced alongside it.

**G15 Broken checkpoint restoration**

Checkpoint archives were never built on Windows at all: GNU tar read the absolute "C:..." archive path as host:path and tried to reach a remote host, and the caller only logged a warning. The agent transcript and runner state were therefore lost at every segment boundary, and a restore from a checkpoint key could not have worked.

tar now runs with the workspace as its working directory and only relative paths, which both GNU tar and the bsdtar that Windows ships accept. A checkpoint is built and read back from a drive-letter path under test. Found by chasing [AIB-015], which this document had recorded as the pre-existing failure most worth investigating: the assertion was right and the product was wrong.

**G16 Failed resume behavior**

Resume worked, but a resumed segment was judged against a lossy echo of its own earlier results: segment 1 was unaffected and every later segment inherited unevidenced check requirements.

This failure mode was invisible until segment continuation worked, because until then nothing resumed far enough to reach it.

**G18 Runner/harness version mismatch**

The installed runner image predates the current source (no host lanes, no sandbox reaper, no GPU fleet, no contract check).

The installed runner service and this source tree are different versions. Resolving it needs an elevated command on Node 1; this session can neither authorize nor perform that.

**G19 Local versus installed-runner behavioral differences**

Local and installed-runner behaviour cannot be compared while the two are different versions. Blocked on the same elevated step as G18.

## Still open

Not yet investigated in this repository, grouped by category.

- **A** (22): A01 Misinterpreted business type; A02 Misinterpreted services; A03 Incorrect service location; A04 Incorrect branding; A05 Wrong page count; A06 Missing required pages; A07 Missing purchased features; A08 Contradictory customer instructions; A09 Package-scope violations; A10 Fabricated services; A11 Fabricated prices; A13 Fabricated credentials or certifications; A14 Fabricated guarantees; A15 Assumed unavailable assets; A16 Assumed unavailable APIs; A17 Assumed unavailable integrations; A18 Plans incompatible with the runtime; A19 Backend requirements omitted during planning; A20 Missing frontend/backend contracts; A21 Missing booking or payment contracts; A22 Plans requiring unsupported functionality; A23 Incomplete customer journeys
- **B** (25): B03 Inconsistent component interfaces; B04 Missing generated files; B05 Incorrect filenames; B06 Broken imports; B07 Broken internal links; B08 JavaScript runtime errors; B09 Broken buttons; B12 Backend rejecting valid requests; B13 Database schema mismatches; B14 Missing migrations; B15 Fake persistence; B16 Fake booking success; B17 Fake payment success; B18 Fake email success; B19 Missing environment variables; B20 Missing secrets; B21 Incomplete authentication; B22 Incomplete file uploads; B23 Incomplete payment integration; B24 Incompatible dependencies; B25 Missing dependencies; B26 Unsupported runtime APIs; B27 Local success but staging failure; B28 Static analysis passes while browser functionality fails; B29 Independently working features fail when combined
- **C** (35): C01 Generic layouts; C02 Repetitive card grids; C03 Excessive whitespace; C04 Poor content density; C05 Weak typography; C06 Inconsistent spacing; C07 Poor visual hierarchy; C08 Inconsistent colors; C09 Inconsistent components; C10 Inconsistent design tokens; C11 Weak illustrations; C12 Unprofessional graphics; C13 Stock-like generic imagery; C14 Missing appropriate photography; C15 Unlicensed photography; C16 Placeholder assets in final deliverables; C17 Inconsistent design across pages; C18 Desktop layouts that are enlarged mobile layouts; C19 Poor mobile layouts; C20 Poor tablet layouts; C21 Low contrast; C22 Clipping; C23 Horizontal overflow; C24 Inaccessible interactions; C25 Weak calls to action; C26 Unclear conversion journeys; C27 Generic AI-generated copy; C28 Industry-inappropriate aesthetics; C29 Weak visual storytelling; C30 Unnecessary animation; C31 Poor animation performance; C32 Missing reduced-motion support; C33 Weak microinteractions; C34 Poor loading performance; C35 Visual repairs that degrade other pages
- **D** (28): D01 Tests only checking element existence; D02 Primary CTA never clicked; D03 Buttons not functionally tested; D04 Links not functionally tested; D05 Navigation not functionally tested; D06 Valid form submissions not tested; D07 Invalid form submissions not tested; D08 HTTP success mistaken for persistence; D09 Stored data not read back; D10 Asynchronous errors missed; D11 Mocks hiding real integration failures; D12 Email delivery not tested; D13 Bookings not tested; D14 Payments not tested; D15 Uploads not tested; D16 Only one viewport tested; D17 Only one browser tested where compatibility matters; D18 Keyboard accessibility not tested; D19 Missing error-path tests; D20 Missing secret scenarios not tested; D21 Network failures not tested; D22 Backend failures not tested; D23 Broken test environment creating false positives; D24 Tests using stale artifacts; D25 Tests using the wrong environment; D26 Individual feature tests passing while the full journey fails; D27 Acceptance passes with deliberately broken critical functionality; D28 False claims of complete acceptance
- **E** (14): E01 Corrupted screenshots; E05 Missing tablet review where relevant; E06 Reviewer prioritizing appearance over functionality; E07 Inconsistent scoring criteria; E08 Contradictory feedback; E10 Repeated unresolved feedback; E11 Test artifacts mistaken for design defects; E13 Overly harsh scores; E14 Visually attractive but broken websites approved; E15 Correct designs penalized because of misunderstood intent; E16 Wrong build revision reviewed; E17 Wrong screenshot associated with a review; E18 Inconsistent before/after comparisons; E19 Incomplete benchmark reference material
- **F** (17): F01 Misinterpreted reviewer feedback; F02 Symptom fixes instead of root-cause fixes; F03 Unnecessary rewriting of working sections; F04 Unrelated file changes; F05 Functional regressions; F06 New frontend/backend mismatches; F07 Design changes without improvement; F08 Repeated failed approaches; F09 Poor patch-versus-rebuild decisions; F10 Missing evidence of improvement; F11 Contradictory repair objectives; F12 Working features destroyed by visual repairs; F13 Excessive repair cycles; F14 Premature stopping; F17 Lost repair history; F18 Unbounded GPU consumption; F19 Failure to escalate genuine blockers
- **G** (20): G01 Wrong model selected; G02 Incorrect model configuration; G04 Incorrect image preprocessing; G05 Excessive model switching; G06 Model weight reload overhead; G07 GPU VRAM exhaustion; G08 Ollama request failures; G09 Ollama timeouts; G10 Context-window overflow; G11 Requirements lost from context; G12 Excessive conversation-history accumulation; G13 Truncated model output; G14 Partial tool execution treated as success; G17 Concurrent GPU contention; G20 Build artifact mismatches; G21 Review record mismatches; G22 Model log mismatches; G23 Stale worker state; G24 Inaccurate performance metrics; G25 Unbounded time or token consumption
- **H** (20): H01 Incorrect Cloudflare bindings; H02 Missing database migrations; H03 Broken custom domains; H04 SSL/TLS failures; H05 Missing secrets; H06 Inaccessible static assets; H07 Incompatible Cloudflare runtime behavior; H08 Failed production email delivery; H09 Incorrect payment configuration; H10 Missing backups; H11 Inadequate error monitoring; H12 Deployment of outdated artifacts; H13 Incorrect caching; H14 Broken routing; H15 Incomplete staging E2E; H16 Missing rollback strategy; H17 Unapproved deployments; H18 Incorrect environment selection; H19 Missing operational documentation; H20 False claims of production readiness
- **I** (18): I01 Insecure form endpoints; I02 Exposed secrets; I03 Unvalidated inputs; I04 Cross-site scripting; I05 Injection vulnerabilities; I06 Unauthorized data access; I07 Missing rate limits; I08 Unsafe file uploads; I09 Broken session handling; I10 Unprotected personal information; I11 Broken authentication; I12 Broken authorization; I13 Sensitive information in logs; I14 Insecure external integrations; I15 Missing retention/deletion controls where required; I16 False payment verification; I17 Missing audit trails for sensitive operations; I18 False security certification
- **J** (25): J01 Gallery UI disconnected from AI retrieval; J02 Multiple conflicting gallery sources; J03 Removed images still selected; J04 Disabled images still selected; J05 Rejected images automatically reappearing; J06 Stale Node 1 gallery caches; J07 Missing gallery version tracking; J08 Missing selected-reference audit history; J09 Broken image uploads; J10 Invalid image formats; J11 Corrupt images; J12 Missing thumbnails; J13 Broken full-size previews; J14 Incorrect reference metadata; J15 Duplicate references; J16 Low-quality references automatically approved; J17 Unlicensed reference storage; J18 Unauthorized image reuse in customer websites; J19 Owner permission bypass; J20 Gallery changes not reflected in new builds; J21 AI selecting irrelevant reference styles; J22 AI copying a reference too closely; J23 Too many references overloading model context; J24 Package-specific quality discrimination; J25 Gallery failures blocking unrelated website functionality
