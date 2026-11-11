// Routes Crestmont's own AI receptionist line to one environment (Founder, 2026-11-11: real inbound calls reach
// PRODUCTION, not staging). Run by .github/workflows/production-receptionist-routing.yml with the inbound workspace key
// (RETELL_INBOUND_API_KEY, from the environment, never printed).
//
// It changes ONLY where Retell sends the receptionist's traffic, by replacing the origin of three kinds of URL:
//   - the agent's webhook_url                       (call events            → /api/webhooks/retell)
//   - every custom tool url on the agent's LLM      (function calls         → /api/webhooks/retell/functions)
//   - inbound_webhook_url on the agent's number(s)  (per-call variables     → /api/webhooks/retell/inbound)
// The prompt, the tools' names, parameters and descriptions, voice, events and every other setting are left exactly as
// they are, and the read-back refuses to report success unless they are byte-for-byte unchanged. A URL that is on
// neither origin is never rewritten (the run refuses). The outbound (sales) workspace is never touched: this key cannot
// even see it. No call is placed.
//
// Retell versioning: agent and LLM edits land on the draft; callers use the published version. The draft is published
// only when it differs from the latest published version in nothing but these URLs (so nothing the Founder has not
// published goes live); otherwise the run stops after saving the draft and says so. A number pinned to the old published
// version is moved to the new one. Rollback: run again with the origins swapped.
//
//   node scripts/retell-route.ts --agent <id> --from <origin> --to <origin> [--apply]
//   node scripts/retell-route.ts --check <origin>   the Worker there verifies this key's signature (a signed no-op
//                                                   event is accepted, an unsigned one refused); writes nothing
// Output (stdout, public): ids, URLs, last 4 digits of numbers, field names. Exit 1 on refusal or failure.
import { RETELL_API_BASE, signRetell } from "../src/adapters/retell.ts";

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : {});
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const str = (x: unknown) => (typeof x === "string" ? x : null);
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const stable = (x: unknown): string => JSON.stringify(x, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
const last4 = (n: unknown) => `…${(str(n) ?? "").replace(/\D/g, "").slice(-4)}`;
export const ORIGIN = /^https:\/\/[A-Za-z0-9.-]+$/;

export const PATHS = { events: "/api/webhooks/retell", functions: "/api/webhooks/retell/functions", inbound: "/api/webhooks/retell/inbound" } as const;

/** The URL on `to` that corresponds to `url`, or why it must not be rewritten. */
export function reroute(url: string | null, kind: keyof typeof PATHS, from: string, to: string): { next: string; change: boolean } | { refuse: string } {
  const want = `${to}${PATHS[kind]}`;
  if (url === want) return { next: want, change: false };
  if (url === `${from}${PATHS[kind]}` || url === null || url === "") return { next: want, change: true };
  return { refuse: `${kind} URL ${url} is on neither ${from} nor ${to}; it is left alone and nothing is changed` };
}

/** Rewritten LLM tools: only `url` of custom tools on `from`/`to` changes. */
export function rerouteTools(tools: Obj[], from: string, to: string): { tools: Obj[]; changed: string[]; refuse: string[] } {
  const changed: string[] = [], refuse: string[] = [];
  const next = tools.map((t) => {
    if (str(t.type) !== "custom" || str(t.url) === null) return t;
    const r = reroute(str(t.url), "functions", from, to);
    if ("refuse" in r) { refuse.push(`tool ${str(t.name) ?? "?"}: ${r.refuse}`); return t; }
    if (!r.change) return t;
    changed.push(str(t.name) ?? "?");
    return { ...t, url: r.next };
  });
  return { tools: next, changed, refuse };
}

const IGNORED_AGENT = new Set(["version", "is_published", "last_modification_timestamp", "webhook_url", "version_title", "base_version", "response_engine"]);
const IGNORED_LLM = new Set(["version", "is_published", "last_modification_timestamp", "general_tools"]);
/** Field names that differ between two objects, ignoring version bookkeeping and the routed fields. */
export function differences(a: Obj, b: Obj, ignored: Set<string>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => !ignored.has(k) && stable(a[k]) !== stable(b[k])).sort();
}
/** Tools with every url origin normalised, so only a non-URL difference counts. */
export const toolsShape = (tools: unknown) => stable(arr(tools).map(obj).map((t) => ({ ...t, url: str(t.url) ? new URL(str(t.url)!).pathname : t.url })));

interface Res { ok: boolean; status: number | null; json: Obj; raw: unknown; error?: string }
interface Api { (method: "GET" | "PATCH" | "POST", path: string, body?: unknown): Promise<Res> }

function api(key: string, f: typeof fetch = fetch): Api {
  return async (method, path, body) => {
    for (let attempt = 0; ; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 20_000);
      try {
        const r = await f(`${RETELL_API_BASE}${path}`, { method, signal: ac.signal, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const text = await r.text();
        let raw: unknown = null;
        try { raw = JSON.parse(text); } catch { /* not JSON */ }
        if ((r.status === 429 || r.status >= 500) && attempt < 2) { await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1))); continue; }
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: obj(raw), raw, error: r.status >= 200 && r.status < 300 ? undefined : `HTTP ${r.status}` };
      } catch (e) {
        if (attempt < 2) continue;
        return { ok: false, status: null, json: {}, raw: null, error: (e as Error).name === "AbortError" ? "timed out" : "network error" };
      } finally { clearTimeout(timer); }
    }
  };
}

/** A list response: a bare array, or { items | data | versions }. */
export const items = (raw: unknown): unknown[] => (Array.isArray(raw) ? raw : arr(obj(raw).items ?? obj(raw).data ?? obj(raw).versions));

/** A signed no-op on the inbound webhook: 200 proves the Worker holds this key; unsigned must be 401. Writes nothing. */
export async function checkSignature(key: string, origin: string, f: typeof fetch = fetch): Promise<{ ok: boolean; detail: string }> {
  const body = JSON.stringify({ event: "crestmont_routing_check" });
  const url = `${origin}${PATHS.inbound}`;
  const signed = await f(url, { method: "POST", headers: { "content-type": "application/json", "x-retell-signature": await signRetell(key, body) }, body }).then((r) => r.status, () => 0);
  const unsigned = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body }).then((r) => r.status, () => 0);
  const ok = signed === 200 && unsigned === 401;
  return { ok, detail: `${url}: signed → ${signed}${signed === 401 ? " (the Worker does not hold this key)" : ""}, unsigned → ${unsigned}` };
}

export interface RouteReport { status: "routed" | "already_routed" | "would_route" | "draft_saved_not_published" | "refused" | "failed"; lines: string[] }

export async function route(o: { key: string; agentId: string; from: string; to: string; apply: boolean; fetch?: typeof fetch; listNumbers?: boolean }): Promise<RouteReport> {
  const lines: string[] = [];
  const say = (l: string) => { lines.push(l); };
  const done = (status: RouteReport["status"], l?: string) => { if (l) say(l); return { status, lines }; };
  if (!ORIGIN.test(o.from) || !ORIGIN.test(o.to) || o.from === o.to) return done("refused", "--from and --to must be two different bare https origins");
  const call = api(o.key, o.fetch);

  // 1. Read everything first.
  const agentR = await call("GET", `/get-agent/${encodeURIComponent(o.agentId)}`);
  if (!agentR.ok) return done("failed", `could not read agent ${o.agentId}: ${agentR.error}${agentR.status === 401 ? " (key rejected: is this the inbound workspace key?)" : ""}`);
  const agent = agentR.json;
  const engine = obj(agent.response_engine);
  const llmId = str(engine.llm_id);
  if (str(engine.type) !== "retell-llm" || !llmId) return done("refused", "the agent is not a single-prompt Retell LLM agent; nothing was changed");
  const llmR = await call("GET", `/get-retell-llm/${encodeURIComponent(llmId)}`);
  if (!llmR.ok) return done("failed", `could not read LLM ${llmId}: ${llmR.error}`);
  const llm = llmR.json;
  const numsR = await call("GET", "/v2/list-phone-numbers?limit=100");
  const numsR2 = numsR.ok ? numsR : await call("GET", "/list-phone-numbers");
  if (!numsR2.ok) return done("failed", `could not list phone numbers: ${numsR2.error}`);
  const numbers = items(numsR2.raw).map(obj).filter((n) => arr(n.inbound_agents).some((a) => str(obj(a).agent_id) === o.agentId) || str(n.inbound_agent_id) === o.agentId);
  say(`agent ${o.agentId} (${str(agent.agent_name) ?? "unnamed"}), version ${num(agent.version) ?? "?"} ${agent.is_published === true ? "published" : "draft"}; LLM ${llmId} v${num(llm.version) ?? "?"}`);
  say(`numbers routing inbound calls to this agent: ${numbers.map((n) => last4(n.phone_number)).join(", ") || "none"}`);
  if (!numbers.length) return done("refused", "no phone number routes inbound calls to this agent; nothing was changed");

  // 2. Plan.
  const hook = reroute(str(agent.webhook_url), "events", o.from, o.to);
  const tools = rerouteTools(arr(llm.general_tools).map(obj), o.from, o.to);
  const numberPlans = numbers.map((n) => ({ n, r: reroute(str(n.inbound_webhook_url), "inbound", o.from, o.to) }));
  const refusals = [...("refuse" in hook ? [hook.refuse] : []), ...tools.refuse, ...numberPlans.flatMap((p) => ("refuse" in p.r ? [`number ${last4(p.n.phone_number)}: ${p.r.refuse}`] : []))];
  if (refusals.length) return done("refused", `refused: ${refusals.join("; ")}`);
  const hookChange = !("refuse" in hook) && hook.change;
  say(`agent webhook_url: ${str(agent.webhook_url) ?? "(none)"} → ${hookChange ? `${o.to}${PATHS.events}` : "unchanged"}`);
  say(`LLM tools: ${tools.changed.length ? `${tools.changed.length} url(s) → ${o.to}${PATHS.functions} (${tools.changed.join(", ")})` : "all already on the target"}`);
  for (const p of numberPlans) say(`number ${last4(p.n.phone_number)} inbound_webhook_url: ${str(p.n.inbound_webhook_url) ?? "(none)"} → ${"refuse" in p.r || !p.r.change ? "unchanged" : p.r.next}`);
  const numberChanges = numberPlans.filter((p) => !("refuse" in p.r) && p.r.change);

  // The published version is what callers hear: it also has to carry the target URLs.
  const versionsR = await call("GET", `/list-agent-versions/${encodeURIComponent(o.agentId)}`);
  const versions = versionsR.ok ? items(versionsR.raw).map(obj) : [];
  const published = versions.filter((v) => v.is_published === true).sort((a, b) => (num(b.version) ?? 0) - (num(a.version) ?? 0))[0] ?? null;
  const publishedRouted = published ? str(published.webhook_url) === `${o.to}${PATHS.events}` : false;
  say(`latest published agent version: ${published ? `v${num(published.version)} (webhook ${str(published.webhook_url) ?? "(none)"})` : versionsR.ok ? "none" : `unknown (${versionsR.error})`}`);
  if (!hookChange && !tools.changed.length && !numberChanges.length && publishedRouted) return done("already_routed", `everything already routes to ${o.to}`);
  if (!o.apply) return done("would_route", "dry run: nothing was written");

  // 3. Draft: tools, then the agent's webhook. Each is read back.
  if (tools.changed.length) {
    const up = await call("PATCH", `/update-retell-llm/${encodeURIComponent(llmId)}`, { general_tools: tools.tools });
    if (!up.ok) return done("failed", `Retell refused the tool update (${up.error}); nothing else was changed`);
  }
  const llmAfter = await call("GET", `/get-retell-llm/${encodeURIComponent(llmId)}`);
  if (!llmAfter.ok) return done("failed", `tool update sent but the LLM could not be read back (${llmAfter.error})`);
  const lp: string[] = [];
  if (str(llmAfter.json.general_prompt) !== str(llm.general_prompt)) lp.push("the prompt changed");
  if (toolsShape(llmAfter.json.general_tools) !== toolsShape(llm.general_tools)) lp.push("a tool other than its url changed");
  if (arr(llmAfter.json.general_tools).map(obj).some((t) => str(t.type) === "custom" && str(t.url) !== null && str(t.url) !== `${o.to}${PATHS.functions}`)) lp.push("a tool url is not on the target");
  const otherLlm = differences(llmAfter.json, llm, IGNORED_LLM);
  if (otherLlm.length) lp.push(`other LLM settings changed: ${otherLlm.join(", ")}`);
  if (lp.length) return done("failed", `LLM read-back mismatch: ${lp.join("; ")}. Check the agent in Retell now.`);
  say("LLM read-back: prompt and every tool unchanged apart from the url");
  if (hookChange) {
    const up = await call("PATCH", `/update-agent/${encodeURIComponent(o.agentId)}`, { webhook_url: `${o.to}${PATHS.events}` });
    if (!up.ok) return done("failed", `Retell refused the agent webhook update (${up.error}); the tool urls were already updated on the draft — run again or roll back with the origins swapped`);
  }
  const agentAfterR = await call("GET", `/get-agent/${encodeURIComponent(o.agentId)}`);
  if (!agentAfterR.ok) return done("failed", `agent update sent but could not be read back (${agentAfterR.error})`);
  const agentAfter = agentAfterR.json;
  const otherAgent = differences(agentAfter, agent, IGNORED_AGENT);
  if (str(agentAfter.webhook_url) !== `${o.to}${PATHS.events}`) return done("failed", `agent read-back: webhook_url is ${str(agentAfter.webhook_url) ?? "(none)"}`);
  if (otherAgent.length) return done("failed", `agent read-back: other settings changed: ${otherAgent.join(", ")}`);
  say("agent read-back: webhook_url on the target, every other setting unchanged");

  // 4. Publish, only when the draft differs from the published version in the routed URLs alone.
  let publishedVersion = published ? num(published.version) : null;
  if (!publishedRouted || agentAfter.is_published !== true) {
    const blockers: string[] = [];
    if (!published) blockers.push("there is no published version to compare with");
    else {
      const pubLlmVersion = num(obj(published.response_engine).version);
      const pubLlm = await call("GET", `/get-retell-llm/${encodeURIComponent(llmId)}${pubLlmVersion !== null ? `?version=${pubLlmVersion}` : ""}`);
      if (!pubLlm.ok) blockers.push(`the published LLM could not be read (${pubLlm.error})`);
      else {
        if (str(pubLlm.json.general_prompt) !== str(llmAfter.json.general_prompt)) blockers.push("the draft prompt differs from the published prompt");
        if (toolsShape(pubLlm.json.general_tools) !== toolsShape(llmAfter.json.general_tools)) blockers.push("the draft tools differ from the published tools");
        const d = differences(llmAfter.json, pubLlm.json, IGNORED_LLM);
        if (d.length) blockers.push(`draft LLM settings differ: ${d.join(", ")}`);
      }
      const d = differences(agentAfter, published, IGNORED_AGENT);
      if (d.length) blockers.push(`draft agent settings differ: ${d.join(", ")}`);
    }
    if (blockers.length) {
      say(`not published automatically: ${blockers.join("; ")} — publishing would put unpublished edits live`);
      return finishNumbers("draft_saved_not_published", null);
    }
    const pub = await call("POST", `/publish-agent/${encodeURIComponent(o.agentId)}`, {});
    if (!pub.ok) { say(`publish-agent failed (${pub.error}): publish the agent in the Retell dashboard`); return finishNumbers("draft_saved_not_published", null); }
    const vs = await call("GET", `/list-agent-versions/${encodeURIComponent(o.agentId)}`);
    const newest = (vs.ok ? items(vs.raw).map(obj) : []).filter((v) => v.is_published === true).sort((a, b) => (num(b.version) ?? 0) - (num(a.version) ?? 0))[0];
    if (!newest || str(newest.webhook_url) !== `${o.to}${PATHS.events}`) { say("published, but the newest published version does not show the target webhook: check in Retell"); return finishNumbers("failed", null); }
    say(`published agent v${num(newest.version)}: callers now get the target URLs`);
    const prev = publishedVersion;
    publishedVersion = num(newest.version);
    return finishNumbers("routed", prev);
  }
  return finishNumbers("routed", null);

  // 5. Numbers last, so the first webhook of a call reaches the target only once the agent's own traffic does.
  async function finishNumbers(status: RouteReport["status"], oldVersion: number | null): Promise<RouteReport> {
    if (status !== "routed") { say("phone numbers left unchanged until the agent version callers use carries the target URLs"); return { status, lines }; }
    for (const p of numberPlans) {
      const pins = arr(p.n.inbound_agents).map(obj);
      const repin = oldVersion !== null && publishedVersion !== null && pins.some((a) => str(a.agent_id) === o.agentId && num(a.agent_version) === oldVersion);
      const change = !("refuse" in p.r) && p.r.change;
      if (!change && !repin) continue;
      const body: Obj = { inbound_webhook_url: `${o.to}${PATHS.inbound}` };
      if (repin) body.inbound_agents = pins.map((a) => (str(a.agent_id) === o.agentId && num(a.agent_version) === oldVersion ? { ...a, agent_version: publishedVersion } : a));
      const up = await call("PATCH", `/update-phone-number/${encodeURIComponent(str(p.n.phone_number) ?? "")}`, body);
      if (!up.ok) { say(`number ${last4(p.n.phone_number)}: Retell refused the update (${up.error})`); return { status: "failed", lines }; }
      const back = await call("GET", `/get-phone-number/${encodeURIComponent(str(p.n.phone_number) ?? "")}`);
      const b = back.ok ? back.json : obj(items((await call("GET", "/v2/list-phone-numbers?limit=100")).raw).map(obj).find((x) => str(x.phone_number) === str(p.n.phone_number)));
      if (str(b.inbound_webhook_url) !== `${o.to}${PATHS.inbound}`) { say(`number ${last4(p.n.phone_number)}: read-back shows ${str(b.inbound_webhook_url) ?? "(none)"}`); return { status: "failed", lines }; }
      say(`number ${last4(p.n.phone_number)}: inbound webhook on the target${repin ? `, now on agent v${publishedVersion}` : ""} (read back)`);
    }
    say(`routed: the receptionist's inbound calls, call events and function calls go to ${o.to}`);
    return { status, lines };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  const opt = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const key = process.env.RETELL_INBOUND_API_KEY ?? "";
  if (!key) { console.error("RETELL_INBOUND_API_KEY is not set"); process.exit(1); }
  const check = opt("--check");
  if (check) {
    const c = await checkSignature(key, check.replace(/\/$/, ""));
    console.log(`signature check: ${c.ok ? "pass" : "FAIL"} — ${c.detail}`);
    process.exit(c.ok ? 0 : 1);
  }
  const r = await route({ key, agentId: opt("--agent") ?? "", from: (opt("--from") ?? "").replace(/\/$/, ""), to: (opt("--to") ?? "").replace(/\/$/, ""), apply: a.includes("--apply") });
  for (const l of r.lines) console.log(l);
  console.log(`status: ${r.status}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Receptionist routing: ${r.status}\n\n${r.lines.map((l) => `- ${l}`).join("\n")}\n`);
  }
  process.exit(["routed", "already_routed", "would_route"].includes(r.status) ? 0 : 1);
}
