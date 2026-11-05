-- Blocker reconciliation against the Founder directive of 2026-11-04 and the evidence already in the repository.
--
-- Only blockers whose OWN required action is demonstrably complete are resolved here. Where a blocker's text is
-- stale but part of its action genuinely remains, the text is corrected and the blocker stays open — a stale
-- description is not a reason to close something, and neither is a Founder decision that does not do the work.

-- BLK-008 — portfolio relationship documentation. Required action: "Document Crestmont's role in each project
-- before publishing case studies." Done: src/content/portfolio-projects.ts FOUNDER_AUTHORIZATION records the
-- relationship, the written authorization and its date; scripts/portfolio-setup.ts writes relationship,
-- relationship_documented_at and relationship_evidence for every project and audits
-- portfolio.relationship_documented; src/services/portfolio.ts refuses to publish a project whose relationship is
-- undocumented. The Founder reconfirmed on 2026-11-04 that he personally owns and developed Lansing Car Rentals,
-- Better Lansing Mechanics and Glassly Auto Glass, and authorises showing them.
UPDATE blockers SET status = 'resolved', resolved_at = '2026-11-04T00:00:00Z',
  resolution_evidence = 'Founder ownership and development of Lansing Car Rentals, Better Lansing Mechanics and Glassly Auto Glass confirmed in writing (2026-10-27, reconfirmed 2026-11-04). Recorded in code as FOUNDER_AUTHORIZATION (src/content/portfolio-projects.ts) and written to every portfolio row by scripts/portfolio-setup.ts as relationship, relationship_documented_at and relationship_evidence, with a portfolio.relationship_documented audit entry. publishBlockers() in src/services/portfolio.ts still refuses to publish any project whose relationship is undocumented, so the control that made this a blocker remains enforced.'
  WHERE id = 'BLK-008' AND status = 'open';

-- BLK-011 — official domain. Required action: "Confirm registrar and DNS ownership; grant DNS access." Done: the
-- Founder confirmed on 2026-11-04 that crestmontwebsitedevelopment.com is under his control with Cloudflare
-- managing its DNS, and that support@, sales@, billing@ and legal@ already route through it. Public DNS is
-- consistent with that (Cloudflare MX and SPF observed 2026-11-01).
UPDATE blockers SET status = 'resolved', resolved_at = '2026-11-04T00:00:00Z',
  resolution_evidence = 'Founder confirmed on 2026-11-04 that crestmontwebsitedevelopment.com is under Crestmont control with Cloudflare managing DNS, and that the four business addresses already route through it. Public DNS observed 2026-11-01 is consistent: MX to route1/2/3.mx.cloudflare.net with SPF include:_spf.mx.cloudflare.net. Adding the zone to the Crestmont Cloudflare account and pointing a production route at it remain part of production provisioning (LAUNCH-002), not of this blocker.'
  WHERE id = 'BLK-011' AND status = 'open';

-- BLK-009 — AI receptionist provider. Its required action was "Review provider recommendation and approve cost".
-- That decision is made and executed: Retell is selected, both workspaces are configured, and deploy #126's live
-- read-only Retell audit passed 35/35 with agent agent_b6ed20f033422649ecf1aedd38, all 17 functions matching the
-- backend, the correct webhook URLs and number …2055 bound and routing to the receptionist. No purchase remains.
UPDATE blockers SET status = 'resolved', resolved_at = '2026-11-04T00:00:00Z',
  resolution_evidence = 'Provider selected and provisioned: Retell, approved by the Founder and configured in two separate workspaces. Live read-only audit on staging deploy #126 (GitHub Actions run 41552270741) passed 35/35 — inbound workspace key accepted, agent agent_b6ed20f033422649ecf1aedd38 recorded, all 17 functions matching the backend contract, webhook and inbound webhook URLs correct, and phone number ...2055 bound and routing to the receptionist. A live inbound CALL is still outstanding, but that is VOICE-002 and VOICE-003 acceptance, not this blocker: nothing further needs selecting or buying.'
  WHERE id = 'BLK-009' AND status = 'open';

-- BLK-014 — logo. The mark itself is NOT a blocker: the Founder's original is committed and in use, and the
-- directive is explicit that it must not be redesigned. Its text asked for a vector or a >= 1000 px master for
-- hero, print, social and app-icon use. Social and app-icon are already served (og-image.png 1200x630,
-- favicon-16/32). Correct the text so it names only what is genuinely outstanding; it stays open because no
-- vector or large master exists and only the Founder can supply the original artwork.
UPDATE blockers SET
  description = 'No vector or large (>= 1000 px) master of the Crestmont logo exists. The Founder''s original 232x213 raster is committed and in use, and social and app-icon sizes are already served (og-image.png 1200x630, favicon-16/32). Only print and any future hero-size use would need a master.',
  required_action = 'Supply the original vector (SVG/AI/EPS/PDF) or a >= 1000 px PNG of the EXISTING mark if a print or hero-size use arises. The logo must not be redesigned or redrawn.',
  severity = 'low', updated_at = '2026-11-04T00:00:00Z'
  WHERE id = 'BLK-014' AND status = 'open';

-- BLK-005 — Resend and mail routing. INBOUND routing is done (the four business addresses forward to the
-- Founder's mailbox through Cloudflare Email Routing). Authenticated OUTBOUND sending is not: no Resend account,
-- no verified sending domain, no RESEND_API_KEY. The blocker stays open, narrowed to the part that remains.
UPDATE blockers SET
  description = 'Authenticated outbound email is not configured: no Resend account, no verified sending domain and no RESEND_API_KEY, so the platform falls back to the development outbox and delivers nothing. Inbound routing is already in place: support@, sales@, billing@ and legal@ forward to the Founder''s mailbox through Cloudflare Email Routing.',
  required_action = 'Create the Resend account, verify crestmontwebsitedevelopment.com as a sending domain (SPF, DKIM, DMARC through the existing Cloudflare DNS), then set RESEND_API_KEY, RESEND_WEBHOOK_SECRET and EMAIL_FROM as Worker secrets on staging and send one real message.',
  updated_at = '2026-11-04T00:00:00Z'
  WHERE id = 'BLK-005' AND status = 'open';

-- BLK-006 — legal identity. The entity is confirmed (Talent Revenue Systems LLC) and recorded in code, but this
-- blocker also gates attorney review and the tax position, which the Founder delegates to counsel and an
-- accountant. Narrow the text to what actually remains.
UPDATE blockers SET
  description = 'Attorney review of the legal suite and the accountant''s tax determination are outstanding. The operating entity itself is settled: Talent Revenue Systems LLC, confirmed by the Founder on 2026-11-04 and recorded in src/domain/business-identity.ts, with Crestmont Website Development as the trading brand. No registered mailing address is published: Crestmont trades online and none was supplied.',
  required_action = 'Engage an attorney to review the agreements and policies (LEGAL-004), and an accountant for the tax position (LEGAL-005). Record the operating entity in Business settings to open production checkout. Supply a registered address only if a provider or law genuinely requires one.',
  updated_at = '2026-11-04T00:00:00Z'
  WHERE id = 'BLK-006' AND status = 'open';

-- BLK-010 — maintenance entitlements. Required action: "Approve or amend proposed entitlements in
-- src/domain/catalog.ts". Done: the Founder confirmed on 2026-11-04 that the plans and pricing are established
-- and directed that the inclusions be taken from this repository rather than reopened, so they are approved
-- exactly as written. ENTITLEMENTS_APPROVAL records who approved, when and on what basis, and the CAT-006 test
-- refuses an approval missing any of those. Maintenance is now purchasable.
UPDATE blockers SET status = 'resolved', resolved_at = '2026-11-04T00:00:00Z',
  resolution_evidence = 'Founder directive 2026-11-04: the maintenance plans and their pricing are established ($99 Essential / $199 Professional / $299 Executive) and the names, entitlements, limits and inclusions are to be taken from this repository rather than reopened. Approved unchanged in src/domain/catalog.ts — nothing added, removed or reworded — with ENTITLEMENTS_APPROVAL recording the approver, the date and the decision. The entitlements gate still refuses any plan that is not approved (tests/crm.test.ts and tests/legal-commerce.test.ts prove it by temporarily unapproving the catalogue).'
  WHERE id = 'BLK-010' AND status = 'open';

-- BLK-015 — the self-hosted AI runner has never produced a draft in a deployed environment.
-- SUP-004 (AI draft replies) and AIOPS-002 (bounded AI workflows) were previously gated on BLK-009, the AI
-- RECEPTIONIST provider blocker. That was a mis-attribution: resolving BLK-009 says nothing about whether a
-- local model has ever produced a draft, and leaving it would have completed both requirements on the strength
-- of an unrelated decision. Their real dependency is recorded here instead.
INSERT OR IGNORE INTO blockers (id, category, description, severity, subsystem, owner, required_action, dependency, status, created_at, updated_at) VALUES
('BLK-015','engineering','The self-hosted AI runner has never produced a draft in a deployed environment. Drafting is exercised only against a stubbed provider and the local-runner fixture, so no real model output exists for AI draft replies (SUP-004) or bounded AI workflows (AIOPS-002). The platform side is complete and verifiable: the AI integration reports the selected backend and verifies it from the runner''s own heartbeat, with no paid API call.','medium','AI Operations','Founder','Install and start the build runner on Node 1 with BUILD_RUNNER_SECRET set on staging, then let one queued AI draft job be claimed and completed by the local model. No paid API and no new spending are involved.',NULL,'open','2026-11-04T00:00:00Z','2026-11-04T00:00:00Z');

INSERT OR IGNORE INTO blocker_seed_links (blocker_id, requirement_id) VALUES ('BLK-015','SUP-004'),('BLK-015','AIOPS-002');
