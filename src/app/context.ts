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
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  ANTHROPIC_API_KEY?: string;
  AI_MODEL?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  VOICE_WEBHOOK_SECRET?: string;
  /** Retell workspace API key that carries the webhook badge (verifies X-Retell-Signature). VOICE-003. */
  RETELL_API_KEY?: string;
  /** Staging only: password for the outer preview gate (src/app/preview-gate.ts). Ignored in production. */
  STAGING_ACCESS_PASSWORD?: string;
  /** "required" on the deployed staging Worker: the preview gate stays locked when no password is set. */
  PREVIEW_GATE?: string;
  /** "local-runner": AI drafts are served by the self-hosted model through the build runner (no paid API). */
  AI_PROVIDER?: string;
  /** Shared HMAC secret for the AI Builds runner API (docs/ai-builds/RUNNER-PROTOCOL.md). Unset = execution unavailable. */
  BUILD_RUNNER_SECRET?: string;
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
  /** business_settings key/values (brand logo, contact details, staffed hours...). */
  settings: Record<string, string>;
  /** Parsed urlencoded or multipart body, cached. */
  form(): Promise<FormData>;
}
