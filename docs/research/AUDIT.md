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
  - the rendered page shows another business's contact details;
  - a "broken" claim that no longer reproduces;
  - every testable material claim refuted.
- **A (strong):**
  - the listed site is still broken on re-check;
  - or a supported high-severity problem (no mobile viewport / sideways scroll, no HTTPS, insecure form, high-severity link breakage) on a site whose identity re-confirms;
  - or two or more supported problems on a confirmed site that is not mobile-friendly.
- **B (moderate):**
  - at least one supported material claim;
  - or "no official website found". Existence rests on the open dataset only, and the absence of a website cannot be proven without a search engine.
- **C (weak):** material claims not testable (insufficient evidence), or only minor problems reproduce.

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
