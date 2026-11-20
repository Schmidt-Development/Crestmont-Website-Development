// Builds the native-readiness dependencies from the Worker environment (routes and the scheduled job share it).
import type { Env } from "../../app/context.ts";
import type { Db } from "../../lib/db.ts";
import { remoteBrowserConfig } from "../remote-browser/admission.ts";
import { connectionsFrom } from "./connections.ts";
import { browserRunOpener } from "./verify.ts";
import type { NativeDeps } from "./orchestrator.ts";
import { R2Storage, type R2BucketLike } from "../../adapters/storage.ts";

export function nativeDepsFrom(env: Env, db: Db, siteOrigin: string): NativeDeps {
  const cap = Number(env.PORTFOLIO_NATIVE_VERIFY_DAILY), onboard = Number(env.PORTFOLIO_NATIVE_ONBOARD_DAILY), conc = Number(env.PORTFOLIO_NATIVE_CONCURRENCY);
  return {
    db, siteOrigin,
    fetchSite: env.overrides?.portfolioFetch ?? fetch,
    fetchApi: env.overrides?.providerFetch ?? fetch,
    conn: connectionsFrom(env as unknown as Record<string, unknown>),
    openBrowser: env.overrides?.nativeBrowser ?? (env.BROWSER ? browserRunOpener(env.BROWSER) : null),
    fixture: env.overrides?.nativeFixture,
    verify: env.overrides?.nativeVerify,
    verifyDailyCap: Number.isFinite(cap) && cap >= 0 && cap <= 100 ? cap : 10,
    // New websites: up to 120 first-time verifications a day by default (about 1–1.5 browser-minutes each).
    onboardDailyCap: env.PORTFOLIO_NATIVE_ONBOARD_DAILY !== undefined && Number.isFinite(onboard) && onboard >= 0 && onboard <= 400 ? onboard : 120,
    concurrency: env.PORTFOLIO_NATIVE_CONCURRENCY !== undefined && Number.isFinite(conc) && conc >= 1 && conc <= 8 ? Math.floor(conc) : 2,
    remoteEnabled: remoteBrowserConfig(env).enabled,
    storage: env.overrides?.storage !== undefined ? env.overrides.storage : env.FILES ? new R2Storage(env.FILES as R2BucketLike) : null,
  };
}
