// Builds the native-readiness dependencies from the Worker environment (routes and the scheduled job share it).
import type { Env } from "../../app/context.ts";
import type { Db } from "../../lib/db.ts";
import { remoteBrowserConfig } from "../remote-browser/admission.ts";
import { connectionsFrom } from "./connections.ts";
import { browserRunOpener } from "./verify.ts";
import type { NativeDeps } from "./orchestrator.ts";

export function nativeDepsFrom(env: Env, db: Db, siteOrigin: string): NativeDeps {
  const cap = Number(env.PORTFOLIO_NATIVE_VERIFY_DAILY);
  return {
    db, siteOrigin,
    fetchSite: env.overrides?.portfolioFetch ?? fetch,
    fetchApi: env.overrides?.providerFetch ?? fetch,
    conn: connectionsFrom(env),
    openBrowser: env.overrides?.nativeBrowser ?? (env.BROWSER ? browserRunOpener(env.BROWSER) : null),
    fixture: env.overrides?.nativeFixture,
    verify: env.overrides?.nativeVerify,
    verifyDailyCap: Number.isFinite(cap) && cap >= 0 && cap <= 100 ? cap : 10,
    remoteEnabled: remoteBrowserConfig(env).enabled,
  };
}
