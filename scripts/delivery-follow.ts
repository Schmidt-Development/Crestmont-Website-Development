// Follows email deliveries until Resend's webhook answers. Two status sources, neither printing an address, subject or
// body: the signed ops endpoint (staging, where workflows know EVIDENCE_INGEST_SECRET) or a read-only query of the
// environment's D1 database with `wrangler d1 execute` (production, whose ops secret no workflow knows).
import { execFileSync } from "node:child_process";
import { signEvidence } from "../src/readiness/ingest.ts";

export interface DeliveryState { status: string; accepted: boolean; events: string[]; error: string }
export type StatusSource = (id: string) => Promise<DeliveryState | null>;

export function signedSource(base: string, secret: string): StatusSource {
  return async (id) => {
    const u = new URL(`${base}/api/ops/email-deliveries/${id}`);
    const d = await fetch(u, { headers: { "x-crestmont-signature": await signEvidence(secret, `GET ${u.pathname}${u.search}`) }, signal: AbortSignal.timeout(20_000) })
      .then((x) => (x.ok ? x.json() : null)).catch(() => null) as { status?: string; acceptedByResend?: boolean; events?: { type: string }[]; lastError?: string | null } | null;
    return d?.status ? { status: d.status, accepted: !!d.acceptedByResend, events: (d.events ?? []).map((e) => e.type), error: d.lastError ?? "" } : null;
  };
}

export function d1Source(database: string, env: string, wrangler = (process.env.WRANGLER ?? "npx --yes wrangler@4.149.0").split(" ")): StatusSource {
  return async (id) => {
    if (!/^em_[A-Za-z0-9_-]{4,64}$/.test(id)) return null;
    const sql = `SELECT d.status, d.provider_message_id IS NOT NULL AS accepted, substr(COALESCE(d.last_error,''),1,200) AS err, (SELECT group_concat(e.type, ' → ') FROM (SELECT type FROM email_webhook_events WHERE delivery_id = d.id ORDER BY received_at) e) AS events FROM email_deliveries d WHERE d.id = '${id}'`;
    try {
      const out = execFileSync(wrangler[0], [...wrangler.slice(1), "d1", "execute", database, "--remote", "--env", env, "--json", "--command", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const r = JSON.parse(out)[0].results[0] as { status: string; accepted: number; err: string; events: string | null } | undefined;
      return r ? { status: r.status, accepted: !!r.accepted, events: r.events ? r.events.split(" → ") : [], error: r.err.replace(/[^\s@<>]+@[^\s@<>]+/g, "<address>") } : null;
    } catch { return null; }
  };
}

/** Polls until each delivery is final for its probe ("bounced" probes expect a bounce). */
export async function follow(ids: { id: string; probe: "delivered" | "bounced" }[], source: StatusSource, opts: { rounds?: number; intervalMs?: number; log?: (s: string) => void } = {}) {
  const states = new Map<string, DeliveryState>();
  const final = (p: string, s?: DeliveryState) => !!s && (p === "bounced" ? ["bounced", "failed", "suppressed"] : ["delivered", "bounced", "failed", "suppressed"]).includes(s.status);
  for (let round = 0; round < (opts.rounds ?? 20); round++) {
    if (round) await new Promise((r) => setTimeout(r, opts.intervalMs ?? 15_000));
    for (const { id, probe } of ids) {
      if (final(probe, states.get(id))) continue;
      const s = await source(id);
      if (s) states.set(id, s);
    }
    opts.log?.(`  round ${round + 1}: ${[...states.values()].filter((s) => s.status === "delivered").length}/${ids.length} delivered`);
    if (ids.every(({ id, probe }) => final(probe, states.get(id)))) break;
  }
  return states;
}
