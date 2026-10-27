# Crestmont Build Ledger

Persistent record so any engineering session can resume (§72). Authoritative status is computed by the readiness engine; this file records decisions, context and next actions.

## Session 1 — 2026-10-26

### Discovery findings
- **Logo:** not supplied in the workspace → BLK-001. No substitute was made.
- **GitHub:** no Crestmont repository exists. Accessible repos: better-lansing-mechanics, lansing-car-rentals, Headquarters, glassly (none modified). This session cannot create repos (gh token invalid) → BLK-002. Code lives in the workspace and is delivered as an archive until a repo is provided.
- **Domain:** crestmontwebsitedevelopment.com could not be verified (fetch disallowed by robots, shell egress denied) → BLK-011.
- **Portfolio sites** (read via web fetch, text only; no screenshots yet):
  - betterlansingmechanics.com — resolves. Auto repair shop, Lansing MI; site names *Noahs Consulting LLC* as operator. Has services catalogue, Spanish version, customer login/portal, callback form, before/after sliders. Site itself states online appointments, phone/AI receptionist and SMS are not yet active.
  - lansingcarrentals.com — resolves. Single-page site; booking via links to Turo; partner application page; site names *Akelle Richmond* as owner. Contains owner-reported fleet figures — do **not** repeat them as Crestmont claims.
  - mentorship.lansingcarrentals.com — resolves. Single-page booking for a paid 30-minute call; Stripe-hosted checkout; no-refund policy.
  - Screenshots blocked: workspace egress denies these domains and the linked computer's browser did not respond → BLK-007. Relationship of each business to Crestmont needs documentation → BLK-008.
- **Workspace limits:** npm/pypi registries unreachable → no third-party packages. Everything so far is dependency-free and runs on Node 22 built-ins.

### Built and verified (development only)
Requirements inventory (154 items), full relational schema (2 migrations), readiness engine + signed CI evidence ingestion, CSV export, server-side catalog/pricing, CRM and project state machines, revision/inactivity/release rules, permissions with MFA and tenant checks, refund workflow rules, Stripe webhook verification + idempotent event store, lead capture API. 35 tagged tests pass; typecheck clean. No staging or production environment exists.

Readiness snapshot (computed, not hand-entered): 11/154 implemented · 34/154 have passing dev evidence · 24 blocked · 0 staging · 0 production. Gates A, C–G fail; H not evaluable. **Not production-ready.**

### Founder decisions needed
1. Create the private repo and grant access (BLK-002).
2. Upload the original logo (BLK-001).
3. Cloudflare account + scoped API token (BLK-003); Stripe test account (BLK-004); Resend + mailbox provider (BLK-005).
4. Approve or amend proposed maintenance entitlements in `src/domain/catalog.ts` (BLK-010) — overage rates there are proposals.
5. Document Crestmont's relationship to the three portfolio businesses (BLK-008).
6. Choose managed auth provider (cost approval).
7. Voice provider: recommendation to follow once account access exists; no number will be purchased before approval (BLK-009).

### Next actions (engineering)
1. Push to the repo; enable branch protection; let CI produce the first real `gh-*` evidence run.
2. Provision dev/staging D1 + R2; deploy the API to staging; point CI evidence at it.
3. Capture genuine portfolio screenshots via browser automation once a browser or egress is available.
4. Design system + public site (Phase 4–5), then auth wiring, Stripe test checkout, customer portal.
5. Readiness dashboard UI and Founder approval panel.
