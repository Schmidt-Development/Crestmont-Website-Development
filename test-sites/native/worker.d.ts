// Types for the trial-site Worker (worker.js is plain JavaScript so wrangler deploys it as-is).
declare const worker: { fetch(req: Request, env: { VARIANT?: string }): Promise<Response> };
export default worker;
