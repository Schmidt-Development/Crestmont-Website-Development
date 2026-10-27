// Cloudflare Worker entry point. All routing lives in src/app/app.ts and src/routes/*.
import { handle } from "./app/app.ts";
export type { Env } from "./app/context.ts";
export { handle };
export default { fetch: handle };
