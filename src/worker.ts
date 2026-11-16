// Cloudflare Worker entry point. All routing lives in src/app/app.ts and src/routes/*;
// cron-triggered jobs live in src/app/scheduled.ts.
import { handle } from "./app/app.ts";
import { scheduled } from "./app/scheduled.ts";
import { installEgressGuard } from "./lib/egress.ts";

// Every outbound request from the deployed Worker goes through the egress allowlist (ASVS F-11).
installEgressGuard();
export type { Env } from "./app/context.ts";
// Remote-browser sessions for the portfolio (Mode B): one Durable Object per visitor session.
export { PortfolioBrowser } from "./durable/portfolio-browser.ts";
export { handle };
export default { fetch: handle, scheduled };
