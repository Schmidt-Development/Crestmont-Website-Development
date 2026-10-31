// Per-request context shared by every route.
import type { Db } from "../lib/db.ts";
import type { Actor, Role } from "../domain/authz.ts";
import type { EmailAdapter } from "../adapters/email.ts";
import type { StorageAdapter } from "../adapters/storage.ts";
import type { PaymentsAdapter } from "../adapters/payments.ts";

export interface Env {
  DB: Db;
  ENVIRONMENT: "development" | "staging" | "production";
  APP_URL?: string;
  EVIDENCE_INGEST_SECRET?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  /**
   * "true" enables the test-only payment simulation (src/services/payment-simulation.ts) for organizations the Owner
   * marked as fictional test organizations. Always refused when ENVIRONMENT is "production", whatever this says.
   */
  PAYMENT_SIMULATION_ENABLED?: string;
  /** Founder flag (CREST-GAP-008, PAY-010): exactly "yes" allows live Stripe keys on production only. Unset = no live payments anywhere. */
  PAYMENTS_LIVE_AUTHORIZED?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  /** Staging only: comma-separated addresses and/or "@domain" entries that may receive real mail (default "@crestmontwebsitedevelopment.com"). */
  EMAIL_RECIPIENT_ALLOWLIST?: string;
  ANTHROPIC_API_KEY?: string;
  AI_MODEL?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  VOICE_WEBHOOK_SECRET?: string;
  /** Retell workspace API key that carries the webhook badge (verifies X-Retell-Signature). VOICE-003. */
  RETELL_API_KEY?: string;
  /** "on" enables outbound calling in this environment (default off). The Owner's receptionist setting must also be on. */
  RETELL_OUTBOUND?: string;
  /** "on" lets the Founder-activated sales optimizer write to the PRODUCTION Retell sales agent (SALESOPT-008). Default off. */
  SALES_OPT_PRODUCTION?: string;
  /** Emergency re-lock only: password for the preview gate (src/app/preview-gate.ts); ignored unless PREVIEW_GATE = "required". */
  STAGING_ACCESS_PASSWORD?: string;
  /** Approved isolated portfolio demo origins (https only, comma/space separated). Only these may be framed. */
  PORTFOLIO_DEMO_ORIGINS?: string;
  /** Emergency re-lock: "required" turns the staging preview gate on (fails closed without a password). Unset = public. */
  PREVIEW_GATE?: string;
  /** "local-runner": AI drafts are served by the self-hosted model through the build runner (no paid API). */
  AI_PROVIDER?: string;
  /** Shared HMAC secret for the AI Builds runner API (docs/ai-builds/RUNNER-PROTOCOL.md). Unset = execution unavailable. */
  BUILD_RUNNER_SECRET?: string;
  /**
   * "true" lets a build runner that does not declare zero token cost (a paid model provider such as the Claude Agent SDK
   * adapter) claim builds. Unset = only zero-cost (self-hosted) runners get work. Second key next to the runner's own
   * RUNNER_ALLOW_PAID_PROVIDER: paid AI needs both, plus the budgets in Owner → AI builds.
   */
  BUILD_ALLOW_PAID_PROVIDER?: string;
  /** Comma-separated host suffixes a build preview URL may use (default ".workers.dev"). Other URLs are not recorded. */
  BUILD_PREVIEW_HOSTS?: string;
  /**
   * Private AI-builder previews (Founder decision D3): signs the 5-minute sign-in links the preview gate accepts. The
   * same value (≥32 random characters) as the runner's PREVIEW_GATE_SECRET. Unset = previews cannot be opened.
   */
  BUILD_PREVIEW_GATE_SECRET?: string;
  /** "yes" refuses runner requests without a replay-protection nonce (CREST-GAP-087). */
  RUNNER_REQUIRE_NONCE?: string;
  /** HMAC key for POST /api/scheduled/run (external scheduler when native Cron Triggers are unavailable). */
  SCHEDULER_TRIGGER_SECRET?: string;
  /** HMAC secret for the research-agent / CRM import API (POST /api/crm/v1/imports). Unset = the endpoint answers 503. */
  CRM_IMPORT_SECRET?: string;
  /** HMAC key for CRM erasure tombstones (≥32 chars). Unset on staging/production = no re-import tombstones. */
  CRM_ERASURE_HMAC_KEY?: string;
  /** The previous tombstone key after a rotation, so earlier tombstones keep blocking re-import. */
  CRM_ERASURE_HMAC_KEY_PREVIOUS?: string;
  /** "on" | "off": per-user limits on authenticated form submissions (default on outside development). ASVS F-15. */
  ACTION_RATE_LIMIT?: string;
  /** "on" | "off": breached-password check (default on outside development). ASVS F-06. */
  PASSWORD_BREACH_CHECK?: string;
  /** Resend webhook signing secret (whsec_…), verifies Svix signatures. EMAIL-003. */
  RESEND_WEBHOOK_SECRET?: string;
  /** Base64 of 32 random bytes: AES-GCM key for TOTP secrets at rest (src/lib/totp-secrets.ts). Required outside development. */
  MFA_ENCRYPTION_KEY?: string;
  /** "off" disables the per-request env_metrics UPSERT (READY-006). Default on. */
  ENV_METRICS?: string;
  /** Fraction (0–1) of successful, non-bot requests written to env_metrics; errors are always written. Default 0.1. CREST-GAP-066. */
  ENV_METRICS_SAMPLE?: string;
  /** Strict-Transport-Security max-age in seconds. Unset = 63072000 with includeSubDomains (staging, development). CREST-GAP-029. */
  HSTS_MAX_AGE?: string;
  /** "on" adds includeSubDomains when HSTS_MAX_AGE is set. Only once every subdomain serves HTTPS. */
  HSTS_INCLUDE_SUBDOMAINS?: string;
  /** The Founder's sign-in email. When set, only that account can record or carry a production launch approval. CREST-GAP-020. */
  FOUNDER_EMAIL?: string;
  FILES?: unknown;             // R2 bucket binding
  ASSETS?: { fetch(req: Request): Promise<Response> };
  /** Test/dev hook: overrides the computed adapters. */
  overrides?: Partial<Pick<AppContext, "email" | "storage" | "payments">> & { now?: () => Date; /** Test seam for read-only provider calls (cost import, reconciliation). */ fetch?: typeof fetch };
  /** Legacy test seam retained for the API tests. */
  resolveActor?: (req: Request) => Promise<Actor | null>;
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
  memberships: { organizationId: string; organizationName: string; role: Role }[];
  isStaff: boolean;
}

export interface AppContext {
  req: Request;
  url: URL;
  env: Env;
  db: Db;
  email: EmailAdapter;
  storage: StorageAdapter | null;
  payments: PaymentsAdapter;
  ip: string | null;
  now: () => Date;
  baseUrl: string;
  user: SessionUser | null;
  actor: Actor | null;
  sessionId: string | null;
  sessionMfaVerified: boolean;
  /** When this session last completed a TOTP / recovery-code verification (step-up MFA, src/app/step-up.ts). */
  sessionMfaAt: string | null;
  csrfToken: string;
  flash: { kind: "success" | "error" | "info"; text: string } | null;
  setCookies: string[];
  /** Extra frame-src origins for this response (already validated against PORTFOLIO_DEMO_ORIGINS). */
  frameSrc?: string[];
  /** business_settings key/values (brand logo, contact details, staffed hours...). */
  settings: Record<string, string>;
  /** Parsed urlencoded or multipart body, cached. */
  form(): Promise<FormData>;
}
