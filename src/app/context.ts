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
  FILES?: unknown;              // R2 bucket binding
  ASSETS?: { fetch(req: Request): Promise<Response> };
  /** Test/dev hook: overrides the computed adapters. */
  overrides?: Partial<Pick<AppContext, "email" | "storage" | "payments">> & { now?: () => Date };
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
  csrfToken: string;
  flash: { kind: "success" | "error" | "info"; text: string } | null;
  setCookies: string[];
  /** business_settings key/values (brand logo, contact details, staffed hours...). */
  settings: Record<string, string>;
  /** Parsed urlencoded or multipart body, cached. */
  form(): Promise<FormData>;
}
