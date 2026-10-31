# Lead quality audit: method and rubric

Workflow: `research-lead-audit.yml`. Script: `research-worker/live/audit-leads.ts`. Input: the sealed per-business evidence of a `research-live-sample` run, decrypted only on the Actions runner.

## Why automated, and what that means
The repository is public. Every channel Claude can read from this session (logs, annotations, PR comments) is world-readable. A person-by-person audit by Claude would therefore publish real businesses' names, phone numbers and "your website has problems" judgements. Instead:
- The audit re-verifies every promoted lead with a **different method** from the research pipeline, at a different time.
- It applies the rubric below mechanically.
- It publishes only aggregate counts. The full per-lead table (business, website, location, research score, re-tested findings, evidence URLs, confidence, category, package, explanation) is sealed for the Founder.

**What a machine cannot judge** is commercial fit: budget, intent, decision-maker, willingness to buy. Nothing here infers it. A and B are *technical* opportunities that a person still qualifies commercially.

## Independent method
- **Fresh fetch:** robots.txt honoured, private addresses refused.
- **Real Chromium render:** at desktop 1366×900 and phone 390×844, with JavaScript run. Identity is re-checked on the rendered page, so phone numbers added by scripts count.
- **Every material claim is re-tested on its own** (confidence ≥ 0.6, severity medium or higher):

| Claim | Independent test |
|---|---|
| broken / parked | re-fetch still fails (401/403/429 = not testable) |
| no_viewport_meta | phone render: viewport tag absent or sideways scroll > 8 px |
| images_without_alt | rendered images (≥ 5) with no alt > 50% |
| mixed_content | browser actually loaded http resources on the https page |
| insecure_form | rendered form posts to http |
| obsolete_markup | obsolete element in rendered DOM |
| redirect_chain | > 3 redirects on re-fetch |
| missing_title | rendered document has no title |
| slow_response | > 4 s for the HTML (server response) on re-check |
| no_https | https fails or ends on http |
| broken_internal_links | the listed links still return 404/410/5xx/network error |

Each claim gets one verdict: `supported`, `not_supported` (refuted) or `not_testable`.

## Categories
- **D (invalid):**
  - a duplicate of another promoted lead (same phone, website, or name + street);
  - a "broken" listing whose business has a working site elsewhere (stale listing; found by the same falsification probe as below);
  - the rendered page shows another business's contact details;
  - a "broken" claim that no longer reproduces;
  - every testable material claim refuted.
- **A (strong):**
  - the listed site is still broken on re-check;
  - or a supported high-severity problem (no mobile viewport / sideways scroll, no HTTPS, insecure form, high-severity link breakage) on a site whose identity re-confirms;
  - or two or more supported problems on a confirmed site that is not mobile-friendly.
- **B (moderate):**
  - at least one supported material claim;
  - or "no official website found" that survives a **wider falsification probe** (name-derived `.com`/`.net`/`.biz`/`.us` domains, with and without the city, rendered in a browser) **and** whose existence is corroborated by an independent online profile listed for the business.
- **C (weak):**
  - claims not testable (insufficient evidence);
  - or "no website found" whose existence rests on the open dataset alone;
  - or only minor problems reproduce.
- **D** also covers a "no website" claim **refuted** by finding the business's own site: its rendered page shows the business's phone or street.

The first audit (run 41151326816) counted every "no website found" lead as B without testing that claim. That made A + B look like 99.4%, which was not meaningful, and the rubric was corrected before any re-run (`docs/research/BENCHMARK.md` §4).

## Metrics
- **False-positive rate** = D ÷ audited.
- **Evidence accuracy** = supported ÷ (supported + refuted) material claims. Not-testable claims are reported separately and never counted as supported.

## Gate
These are provisional criteria from the Founder:
- A + B ≥ 80%;
- ≥ 90% of tested material claims supported;
- 0 duplicate promotions;
- 0 do-not-call releases;
- 0 automated cold-call releases.

## Results (automated; per-lead tables are sealed, aggregates only)

| | Baseline: run 41145776120 (audit 41152469504) | After fixes 1–3: run 41153598151 at `980be67` (audit 41156571952) | After fixes 1–6: run 41158326197 at `0267671` (audit 41160629448) |
|---|---|---|---|
| Leads audited | 159 | 328 | 284 |
| A / B / C / D | 17 / 45 / 89 / 8 | 158 / 138 / 3 / 29 | 145 / 132 / 2 / 5 |
| A + B | 39.0% | 90.2% | 97.5% |
| Material claims supported (of tested) | 68% (17 of 25) | 86.2% (187 of 217) | 93.4% (169 of 181); 128 not testable |
| False "no website" | 7 | 2 | 3 |
| Duplicates among promoted | 0 | 4 | 0 (54 records held for a person) |
| False-positive rate (D) | 5.0% | 8.8% | 1.8% |
| Gate | fails | fails (claims < 90%, duplicates > 0) | **passes** |

Root causes fixed, each with a regression test (no threshold was changed):
1. DNS-dead listed domains were recorded as "robots.txt disallows" (`a2a54e6`).
2. "No website found" was never falsified; ISSUES sites could not qualify on evidence (`a2a54e6`).
3. Uncorroborated "no website" records qualified (`980be67`).
4. A dead listing was called "broken" even when the business had moved to a new domain (`89dfa87`).
5. 20 of 35 timeout claims did not reproduce: a single timeout is now confirmed with a patient 45 s request (`0267671`).
6. Records of one business with different numbers shared a website or name + street and became two leads: the later record is now held for a person (`0267671`). The live sample promotes only `qualified` records unattended; `review` records are counted, not promoted.

Caveats on the passing result: 123 of the 132 B leads are "no website found" records. Their absence of a website survived the falsification probe and their existence is independently corroborated, but absence cannot be proven, so that claim is counted as not testable (never as supported) and these leads are B with low confidence. Wrong website matches: 4. False "no website": 3.

The audit is automated. Commercial fit (budget, intent, decision-maker) is never inferred and needs a person.
