// First production Owner, by email (Founder, 2026-11-09). Production's database starts empty: there is no account until
// the first Owner accepts an invitation. scripts/bootstrap-owner.ts writes that invitation as SQL and prints the link on
// the operator's machine; this does the same thing inside the Worker and delivers the link by the normal
// staff_invitation email, so the link never appears in a log, a terminal or a workflow, and its delivery is the first
// real proof that production email works.
//
// Called only through the signed ops endpoint (POST /api/ops/owner-invitation, EVIDENCE_INGEST_SECRET). It refuses:
//   - when an Owner already exists (outside the staging demo domain): the Owner then invites everyone else in the app;
//   - when the address is not the Founder's (FOUNDER_EMAIL on the Worker, when set, must match);
//   - a demo or reserved address, or an address that belongs to a verified customer account (CREST-GAP-001).
// Re-issuing expires the earlier pending Owner invitation, exactly like the script. The invitation is valid 72 hours.
import type { AppContext } from "../app/context.ts";
import { nowIso } from "../lib/db.ts";
import { randomToken, hashToken } from "../lib/auth-crypto.ts";
import { sendMail } from "./mailer.ts";
import { audit } from "./security.ts";
import { DEMO_ACCOUNT_DOMAIN } from "./readiness-admin.ts";

export class OwnerBootstrapError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}

const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RESERVED = /(\.test|\.invalid|\.example|\.localhost)$|@example\.(com|net|org)$/i;

export async function issueFounderOwnerInvitation(ctx: AppContext, emailRaw: string): Promise<{ invitationId: string; expiresAt: string; delivery: { id: string; status: string } }> {
  const email = emailRaw.trim().toLowerCase();
  if (!VALID_EMAIL.test(email) || email.length > 254) throw new OwnerBootstrapError("A valid Founder email address is required.", 422);
  if (email.endsWith(DEMO_ACCOUNT_DOMAIN) || RESERVED.test(email)) throw new OwnerBootstrapError("A demo or reserved address cannot be the Owner.", 422);
  const founder = ctx.env.FOUNDER_EMAIL?.trim().toLowerCase();
  if (founder && founder !== email) throw new OwnerBootstrapError("The address does not match FOUNDER_EMAIL on this Worker.", 403);
  const owners = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role_id = 'owner' AND u.email NOT LIKE ?`)
    .bind(`%${DEMO_ACCOUNT_DOMAIN}`).first<{ n: number }>();
  if ((owners?.n ?? 0) > 0) throw new OwnerBootstrapError("An Owner already exists. The Owner invites staff from the staff area; this one-time invitation is not available.");
  const customer = await ctx.db.prepare(`SELECT 1 AS x FROM users u JOIN memberships m ON m.user_id = u.id JOIN organizations o ON o.id = m.organization_id
     WHERE u.email = ? AND u.email_verified_at IS NOT NULL AND o.kind != 'internal' LIMIT 1`).bind(email).first();
  if (customer) throw new OwnerBootstrapError("That address belongs to a customer account. Use a separate work address for the Owner.");

  const token = randomToken();
  const now = nowIso(ctx.now);
  const expiresAt = new Date(ctx.now().getTime() + 72 * 3600e3).toISOString();
  const invitationId = `inv_owner_bootstrap_${randomToken().slice(0, 12)}`; // independent of the token
  // The same statements as scripts/bootstrap-owner.ts: the internal organization and a disabled system inviter of record
  // (no password; it can never sign in), then the earlier pending Owner invitations expire, then this one is created.
  await ctx.db.batch([
    ctx.db.prepare(`INSERT OR IGNORE INTO organizations (id, name, kind, created_at) VALUES ('org_crestmont', 'Crestmont Website Development', 'internal', ?)`).bind(now),
    ctx.db.prepare(`INSERT OR IGNORE INTO users (id, email, display_name, password_hash, disabled_at, created_at) VALUES ('usr_system', 'system@crestmont.invalid', 'Crestmont system', NULL, ?, ?)`).bind(now, now),
    ctx.db.prepare(`UPDATE invitations SET expires_at = ? WHERE role_id = 'owner' AND accepted_at IS NULL AND expires_at > ?`).bind(now, now),
    ctx.db.prepare(`INSERT INTO invitations (id, email, organization_id, role_id, token_hash, invited_by, expires_at) VALUES (?, ?, 'org_crestmont', 'owner', ?, 'usr_system', ?)`)
      .bind(invitationId, email, await hashToken(token), expiresAt),
  ]);
  const r = await sendMail(ctx, { template: "staff_invitation", to: email, idempotencyKey: `owner-bootstrap:${invitationId}`,
    data: { inviterName: "Crestmont", roleLabel: "Owner", acceptUrl: `${ctx.baseUrl}/invite?token=${token}` } });
  await audit(ctx.db, { actorKind: "system", action: "owner.bootstrap_invitation_sent", subjectType: "invitation", subjectId: invitationId, details: { delivery: r.status } });
  return { invitationId, expiresAt, delivery: { id: r.deliveryId, status: r.status } };
}

/** Status of one email delivery for the signed ops check: no address, subject or body. */
export async function deliveryStatus(ctx: AppContext, id: string) {
  const d = await ctx.db.prepare(`SELECT id, template, status, attempts, provider_message_id, last_error, created_at, updated_at FROM email_deliveries WHERE id = ?`).bind(id)
    .first<{ id: string; template: string; status: string; attempts: number; provider_message_id: string | null; last_error: string | null; created_at: string; updated_at: string }>()
    .catch(() => null);
  if (!d) return null;
  const events = (await ctx.db.prepare(`SELECT type, received_at FROM email_webhook_events WHERE delivery_id = ? ORDER BY received_at`).bind(id)
    .all<{ type: string; received_at: string }>().catch(() => ({ results: [] as { type: string; received_at: string }[] }))).results;
  return { id: d.id, template: d.template, status: d.status, attempts: d.attempts, acceptedByResend: !!d.provider_message_id, createdAt: d.created_at, updatedAt: d.updated_at,
    lastError: d.last_error ? d.last_error.replace(/[^\s@<>]+@[^\s@<>]+/g, "<address>").slice(0, 300) : null, events };
}
