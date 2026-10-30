# Lead research — architecture

A nationwide business-research engine that fills the existing CRM with evidence-backed website prospects. It adds **$0** in external API, data or inference fees: open bulk datasets, the workstation's own CPU/GPU, Ollama on localhost.

```
Windows workstation (research-worker/)                         Cloudflare (this Worker + D1)
┌───────────────────────────────────────────────┐   HMAC-signed   ┌──────────────────────────────────────────┐
│ Overture snapshot (DuckDB) ─┐                 │   heartbeat ──▶ │ research_runners / runner_days           │
│ [FSQ OS, OSM: off]          ├▶ state.sqlite   │ ◀── controls    │ research_settings (pause, threshold)     │
│ Common Crawl index (cached) │   (queue, leases│   batch ──────▶ │ ingest: validate → recompute score →     │
│ HTTP verify (robots, polite)│    outbox, ckpt)│  (idempotent)   │   CRM contact / DNC / shared-phone checks│
│ audit (+Playwright opt.)    │                 │                 │ research_prospects (evidence, provenance)│
│ Ollama 127.0.0.1 (drafts)  ─┘                 │                 │ /staff/research → promote → CRM lead     │
└───────────────────────────────────────────────┘                 └──────────────────────────────────────────┘
```

## Where things run
- **Workstation:** bulk data (tens of millions of rows), website checks, audits, and the local model. These are the heavy, long-running parts with no per-request cost.
- **Cloudflare:** only candidate prospects with their evidence (opportunity classes with a phone number), their validation, duplicate protection against the CRM, the decisions people make, and the dashboard. The CRM stays the system of record. A prospect becomes a lead only through an audited promotion.

## Vocabulary (reported separately everywhere)
| Term | Meaning | Source of the number |
|---|---|---|
| evaluated | a candidate record the worker finished checking | worker counter, per day |
| received | records the platform got in batches | `research_batches` |
| qualified | meets the deterministic rule in `src/domain/research.ts#qualify` | platform, recomputed on ingest |
| callable | released by the outbound eligibility gate | always 0 today (`COMPLIANCE-GATE.md`) |

## Classifications
`VERIFIED_OFFICIAL_WEBSITE`, `VERIFIED_WEBSITE_BROKEN`, `VERIFIED_WEBSITE_ISSUES`, `NO_OFFICIAL_WEBSITE_FOUND`, `WEBSITE_UNVERIFIED`, `BUSINESS_IDENTITY_UNCERTAIN`.

- **"No official website found"** is reported only after stages A–C ran, and the checks are stored with it. It is never inferred from an empty dataset field, and it is never presented as proof that no website exists.
- **"Broken"** requires a site that a source lists for this business, failing repeatedly at times hours apart.
- **"Official"** requires a phone or street-address match on the page, or a source listing plus a strong name match with no contradicting contact details. A similar name alone is never enough.

## Guarantees enforced in code (with tests)
- Findings without evidence, URL, method, timestamp, severity and confidence are refused at ingest.
- The score, qualification and package are computed from evidence by code. The model only drafts wording, and drafts that add prices, percentages, guarantees, insults or domains not in the evidence are discarded.
- No duplicate calling opportunities:
  - a phone or email already on a CRM contact means `existing_crm`;
  - a do-not-call number means `suppressed`, and opt-outs recorded later propagate immediately;
  - a shared phone between distinct businesses means `review`, never merged;
  - repeated or concurrent batches and concurrent promotions are idempotent.
- The worker's own HTTP client never reaches private networks: IP-literal hosts are checked on every hop (including redirects), and every name is resolved through a filter inside the socket's own lookup, so DNS cannot change between check and connect. The optional Playwright check (off by default) filters sub-requests and WebSockets but resolves names separately from Chromium, so DNS rebinding is not fully prevented there (RUNBOOK §1). The worker honours robots.txt and Crawl-delay (a delay over 60 s counts as "restricted"), never submits forms, and never works around 401/403/429 or CAPTCHAs.
- Ollama must be on 127.0.0.1. The configuration refuses anything else.
- Research ships paused. Sources whose terms are not settled are off on the platform and refused at ingest.

## Proposed requirement IDs
The inventory is the Founder-approved denominator, so these were not added. Tests are tagged with existing CRM / DATA / SEC / OWN / AIOPS / TEST ids in the meantime.
- `RESEARCH-001` Open-data ingestion with licence provenance
- `RESEARCH-002` Website verification and classification (A–E)
- `RESEARCH-003` Evidence-backed website audit
- `RESEARCH-004` Deterministic qualification with local-model drafts
- `RESEARCH-005` CRM integration with duplicate and suppression protection
- `RESEARCH-006` Fail-closed outbound eligibility gate and research dashboard

## Coordination with other open workstreams (2026-10-30)
- **Migrations.** This PR uses `0050_lead_research.sql`. `0047` is the merged sales-optimization migration. Open PR #50 (CRM contact identity) reserves `0048`–`0049`, and open PR #52 (Node 1 diagnostics) also reserves `0048`, so whichever of #50/#52 merges second must renumber. All of these are additive and independent, and D1 records applied migrations by name, so their relative order does not matter.
- **CRM identity (PR #50).** When #50 merges, its triggers on `contacts` will register every research promotion in `contact_identities` automatically. Follow-up: route `promote()` through #50's intake engine (`contact-identity.ts`), so its intake decision and review queue become authoritative for research too. The research prospect store stays evidence-only. Until then, `promote()` re-checks CRM phone/email keys for every number and address immediately before its guarded atomic write.
- **Node 1 (PR #52).** The research worker uses its own HMAC secret and endpoints. It does not share the build runner's lease channel: research batches are idempotent pushes, not leased jobs. It reuses the runner's conventions (signature format, nonce, DPAPI secret, scheduled task).

## Not built yet (honest list)
- **Live benchmark** on the RTX 5090 workstation, and the manually verified false-positive sample. This session had no access to the workstation (RUNBOOK §4).
- **Real data at scale.** Controlled real-data runs (Overture `2026-10-21.0`, live websites, Common Crawl `CC-MAIN-2026-43`; `BENCHMARK.md` §3) ran on a GitHub-hosted runner, not Node 1, with the CRM in-process. Neither the full US snapshot nor staging ingestion has run.
- **Founder decisions:** Foursquare OS access, OSM internal-use, and any outbound consent design with counsel.
- **Data.gov / state open-data enrichment.** The source is registered but off, and no dataset has been reviewed.
- **Parent/subsidiary modelling.** Recognised brand locations (Overture brand + Wikidata) are excluded as brand-managed, and multi-location businesses that share one website are recognised. Corporate parent/subsidiary trees are not modelled.
