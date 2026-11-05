// Connection-phase retry for the deploy scripts that call the staging Worker from the GitHub runner.
//
// Deploy #158 (2026-11-05) failed its access verification on the very first request with only "fetch failed":
//   AggregateError [ETIMEDOUT]: connect ETIMEDOUT 104.21.86.58:443 … connect ETIMEDOUT 172.67.215.91:443
// The runner could not open a TCP connection to Cloudflare's edge; the next step (recording the deployment) failed the
// same way a second later. Nothing reached the Worker, so nothing about the platform was tested, and one network blip
// failed a forty-minute deploy.
//
// Only failures BEFORE the request is sent are retried — connect timeouts and refusals, DNS failures — so retrying is
// safe for any method, the sign-in and MFA POSTs included (nothing was received, so nothing can be applied twice).
// A reset or timeout after the request went out, and every HTTP status, are returned or thrown unchanged.

const CONNECT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

interface NetErr { code?: string; syscall?: string; message?: string; errors?: NetErr[]; cause?: NetErr }

/** True when the error says the connection was never established. */
export function isConnectFailure(e: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (x: NetErr | undefined): boolean => {
    if (!x || typeof x !== "object" || seen.has(x)) return false;
    seen.add(x);
    if (x.code && CONNECT_CODES.has(x.code)) return true;
    if (x.code === "ETIMEDOUT" && x.syscall === "connect") return true;
    return (x.errors ?? []).some(walk) || walk(x.cause);
  };
  return walk(e as NetErr);
}

/** "fetch failed (connect ETIMEDOUT 104.21.86.58:443)": the network reason, not only that a fetch failed. */
export function describeNetError(e: unknown): string {
  const x = e as NetErr;
  const inner = x?.cause?.errors?.[0] ?? x?.cause;
  return inner?.message && inner.message !== x?.message ? `${x?.message ?? e} (${inner.message})` : String(x?.message ?? e);
}

export function withConnectRetry(f: typeof fetch, delaysMs: number[] = [2_000, 5_000, 10_000], log: (s: string) => void = console.log): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    for (let attempt = 0; ; attempt++) {
      try { return await f(input, init); }
      catch (e) {
        if (attempt >= delaysMs.length || !isConnectFailure(e)) throw new Error(describeNetError(e), { cause: e });
        log(`::warning title=Network::${describeNetError(e)}; connection not established, retrying in ${delaysMs[attempt]} ms (attempt ${attempt + 2} of ${delaysMs.length + 1}).`);
        await new Promise((r) => setTimeout(r, delaysMs[attempt]));
      }
    }
  }) as typeof fetch;
}
