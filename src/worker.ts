// Cloudflare Worker entry point. All routing lives in src/app/app.ts and src/routes/*;
// cron-triggered jobs live in src/app/scheduled.ts.
import { handle } from "./app/app.ts";
import { scheduled } from "./app/scheduled.ts";
import { installEgressGuard } from "./lib/egress.ts";

// Every outbound request from the deployed Worker goes through the egress allowlist (ASVS F-11).
installEgressGuard();
export type { Env } from "./app/context.ts";
export { handle };
export default { fetch: handle, scheduled };
