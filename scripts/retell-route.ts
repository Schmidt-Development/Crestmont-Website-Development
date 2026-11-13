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
// Retell versioning (retell-sdk 6.2.20, verified 2026-11-13): published agent versions, and the LLM versions they use,
// are immutable — PATCH on them answers 400 "Cannot update published LLM", which is how the 2026-11-13 run failed. So
// the run starts a NEW draft from the latest published version (POST /create-agent-version {base_version}), which
// copies the agent and its LLM; changes only the URLs on that draft (PATCH ?version=<draft>), reads it back, publishes
// exactly that draft (POST /publish-agent-version {version}), and moves the number. Nothing unpublished goes live: the
// new draft is the published version plus the URL change. An existing unpublished draft is left alone and reported.
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

const IGNORED_AGENT = new Set(["version", "is_published", "last_modification_timestamp", "webhook_url", "version_title", "version_description", "base_version", "response_engine"]);
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
        const ok = r.status >= 200 && r.status < 300;
        return { ok, status: r.status, json: obj(raw), raw, error: ok ? undefined : `HTTP ${r.status}${retellMessage(raw, text)}` };
      } catch (e) {
        if (attempt < 2) continue;
        return { ok: false, status: null, json: {}, raw: null, error: (e as Error).name === "AbortError" ? "timed out" : "network error" };
      } finally { clearTimeout(timer); }
    }
  };
}

/** Retell's own explanation of a refusal (its error body), shortened; it names fields, never the key. */
export function retellMessage(raw: unknown, text: string): string {
  const o = obj(raw);
  const m = str(o.message) ?? str(o.error_message) ?? str(o.error) ?? (Array.isArray(o.message) ? (o.message as unknown[]).join("; ") : null) ?? text;
  const t = (m ?? "").replace(/\s+/g, " ").replace(/(key_|Bearer )[A-Za-z0-9_-]+/g, "$1…").trim().slice(0, 400);
  return t ? `: ${t}` : "";
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
  const A = encodeURIComponent(o.agentId);
  const hookUrl = `${o.to}${PATHS.events}`, fnUrl = `${o.to}${PATHS.functions}`, inUrl = `${o.to}${PATHS.inbound}`;

  // 1. Read: the latest agent, the latest PUBLISHED version (what callers use) and its LLM version, the numbers.
  const latestR = await call("GET", `/get-agent/${A}`);
  if (!latestR.ok) return done("failed", `could not read agent ${o.agentId}: ${latestR.error}${latestR.status === 401 ? " (key rejected: is this the inbound workspace key?)" : ""}`);
  const latest = latestR.json;
  const llmId = str(obj(latest.response_engine).llm_id);
  if (str(obj(latest.response_engine).type) !== "retell-llm" || !llmId) return done("refused", "the agent is not a single-prompt Retell LLM agent; nothing was changed");
  const L = encodeURIComponent(llmId);
  const versionsR = await call("GET", `/list-agent-versions/${A}?limit=100`);
  if (!versionsR.ok) return done("failed", `could not list agent versions: ${versionsR.error}`);
  const versions = items(versionsR.raw).map(obj);
  const pubV = versions.filter((v) => v.is_published === true).map((v) => num(v.version) ?? -1).sort((a, b) => b - a)[0] ?? (latest.is_published === true ? num(latest.version) : null);
  if (pubV === null || pubV < 0) return done("refused", "the agent has no published version; publish it in Retell first (nothing was changed)");
  const pubR = await call("GET", `/get-agent/${A}?version=${pubV}`);
  if (!pubR.ok) return done("failed", `could not read published agent v${pubV}: ${pubR.error}`);
  const pub = pubR.json;
  const pubLlmV = num(obj(pub.response_engine).version);
  const pubLlmR = await call("GET", `/get-retell-llm/${L}${pubLlmV !== null ? `?version=${pubLlmV}` : ""}`);
  if (!pubLlmR.ok) return done("failed", `could not read the published LLM ${llmId}: ${pubLlmR.error}`);
  const pubLlm = pubLlmR.json;
  const numsR = await call("GET", "/v2/list-phone-numbers?limit=100");
  const numsR2 = numsR.ok ? numsR : await call("GET", "/list-phone-numbers");
  if (!numsR2.ok) return done("failed", `could not list phone numbers: ${numsR2.error}`);
  const numbers = items(numsR2.raw).map(obj).filter((n) => arr(n.inbound_agents).some((a) => str(obj(a).agent_id) === o.agentId) || str(n.inbound_agent_id) === o.agentId);
  const latestV = num(latest.version);
  say(`agent ${o.agentId} (${str(pub.agent_name) ?? "unnamed"}): published v${pubV} on LLM ${llmId} v${pubLlmV ?? "?"}; latest version v${latestV ?? "?"} ${latest.is_published === true ? "(published)" : "(unpublished draft)"}`);
  say(`numbers routing inbound calls to this agent: ${numbers.map((n) => last4(n.phone_number)).join(", ") || "none"}`);
  if (!numbers.length) return done("refused", "no phone number routes inbound calls to this agent; nothing was changed");

  // 2. Plan against the PUBLISHED version.
  const hook = reroute(str(pub.webhook_url), "events", o.from, o.to);
  const tools = rerouteTools(arr(pubLlm.general_tools).map(obj), o.from, o.to);
  const numberPlans = numbers.map((n) => ({ n, r: reroute(str(n.inbound_webhook_url), "inbound", o.from, o.to) }));
  const refusals = [...("refuse" in hook ? [hook.refuse] : []), ...tools.refuse, ...numberPlans.flatMap((p) => ("refuse" in p.r ? [`number ${last4(p.n.phone_number)}: ${p.r.refuse}`] : []))];
  if (refusals.length) return done("refused", `refused: ${refusals.join("; ")}`);
  const hookChange = !("refuse" in hook) && hook.change;
  const customTools = arr(pubLlm.general_tools).map(obj).filter((t) => str(t.type) === "custom" && str(t.url) !== null);
  say(`published agent webhook_url: ${str(pub.webhook_url) ?? "(none)"} → ${hookChange ? hookUrl : "unchanged"}`);
  say(`published LLM tools: ${customTools.length} custom tool(s); ${tools.changed.length ? `${tools.changed.length} url(s) → ${fnUrl} (${tools.changed.join(", ")})` : "all already on the target"}`);
  for (const p of numberPlans) say(`number ${last4(p.n.phone_number)} inbound_webhook_url: ${str(p.n.inbound_webhook_url) ?? "(none)"} → ${"refuse" in p.r || !p.r.change ? "unchanged" : p.r.next}`);
  const otherDraft = latest.is_published !== true && latestV !== null && latestV > pubV;
  if (otherDraft) say(`note: unpublished draft v${latestV} exists; it is left exactly as it is (not published, not edited)`);
  const numbersPending = numberPlans.some((p) => !("refuse" in p.r) && p.r.change);
  if (!hookChange && !tools.changed.length && !numbersPending) return done("already_routed", `everything callers use already routes to ${o.to}`);
  if (!o.apply) return done("would_route", "dry run: nothing was written");

  let newV: number | null = pubV;
  if (hookChange || tools.changed.length) {
    // 3. A new draft from the published version (copies the agent and its LLM).
    const created = await call("POST", `/create-agent-version/${A}`, { base_version: pubV });
    if (!created.ok) return done("failed", `Retell refused to create a draft from v${pubV} (${created.error}); nothing was changed`);
    const draftV = num(created.json.version);
    const draftLlmV = num(obj(created.json.response_engine).version);
    if (draftV === null || created.json.is_published === true) return done("failed", `create-agent-version did not return a draft version; nothing else was changed`);
    say(`draft v${draftV} created from published v${pubV} (LLM v${draftLlmV ?? "?"})`);
    if (str(obj(created.json.response_engine).llm_id) !== llmId) return done("failed", `draft v${draftV} uses another LLM; stopped before any edit (delete draft v${draftV} in Retell)`);
    const dLlmR = await call("GET", `/get-retell-llm/${L}${draftLlmV !== null ? `?version=${draftLlmV}` : ""}`);
    if (!dLlmR.ok) return done("failed", `could not read the draft's LLM (${dLlmR.error}); draft v${draftV} left unpublished`);
    const dLlm = dLlmR.json;
    if (dLlm.is_published === true) return done("failed", `the draft's LLM v${draftLlmV} is a published version, which Retell cannot edit; draft v${draftV} left unpublished`);
    if (str(dLlm.general_prompt) !== str(pubLlm.general_prompt) || toolsShape(dLlm.general_tools) !== toolsShape(pubLlm.general_tools) || differences(dLlm, pubLlm, IGNORED_LLM).length)
      return done("failed", `draft v${draftV} is not an exact copy of published v${pubV}; stopped before any edit`);
    // 4. Only the URLs: the tool list as Retell returned it for the draft, with url replaced on the custom tools.
    if (tools.changed.length) {
      const next = rerouteTools(arr(dLlm.general_tools).map(obj), o.from, o.to);
      const up = await call("PATCH", `/update-retell-llm/${L}${draftLlmV !== null ? `?version=${draftLlmV}` : ""}`, { general_tools: next.tools });
      if (!up.ok) return done("failed", `Retell refused the tool update on draft LLM v${draftLlmV} (${up.error}); draft v${draftV} left unpublished, callers unaffected`);
    }
    const llmAfterR = await call("GET", `/get-retell-llm/${L}${draftLlmV !== null ? `?version=${draftLlmV}` : ""}`);
    if (!llmAfterR.ok) return done("failed", `tool update sent but the draft LLM could not be read back (${llmAfterR.error}); not published`);
    const llmAfter = llmAfterR.json;
    const lp: string[] = [];
    if (str(llmAfter.general_prompt) !== str(pubLlm.general_prompt)) lp.push("the prompt changed");
    if (toolsShape(llmAfter.general_tools) !== toolsShape(pubLlm.general_tools)) lp.push("a tool other than its url changed");
    if (arr(llmAfter.general_tools).length !== arr(pubLlm.general_tools).length) lp.push("the number of tools changed");
    if (arr(llmAfter.general_tools).map(obj).some((t) => str(t.type) === "custom" && str(t.url) !== null && str(t.url) !== fnUrl)) lp.push("a tool url is not on the target");
    const otherLlm = differences(llmAfter, pubLlm, IGNORED_LLM);
    if (otherLlm.length) lp.push(`other LLM settings changed: ${otherLlm.join(", ")}`);
    if (lp.length) return done("failed", `draft LLM read-back mismatch: ${lp.join("; ")}; draft v${draftV} left unpublished, callers unaffected`);
    say(`draft LLM read-back: prompt and all ${arr(llmAfter.general_tools).length} tools unchanged apart from ${tools.changed.length} url(s), now ${fnUrl}`);
    if (hookChange) {
      const up = await call("PATCH", `/update-agent/${A}?version=${draftV}`, { webhook_url: hookUrl });
      if (!up.ok) return done("failed", `Retell refused the agent webhook update on draft v${draftV} (${up.error}); not published, callers unaffected`);
    }
    const agentAfterR = await call("GET", `/get-agent/${A}?version=${draftV}`);
    if (!agentAfterR.ok) return done("failed", `draft agent v${draftV} could not be read back (${agentAfterR.error}); not published`);
    const agentAfter = agentAfterR.json;
    if (str(agentAfter.webhook_url) !== hookUrl) return done("failed", `draft agent read-back: webhook_url is ${str(agentAfter.webhook_url) ?? "(none)"}; not published`);
    const otherAgent = differences(agentAfter, pub, IGNORED_AGENT);
    if (otherAgent.length) return done("failed", `draft agent read-back: other settings differ from v${pubV}: ${otherAgent.join(", ")}; not published`);
    if (str(obj(agentAfter.response_engine).llm_id) !== llmId) return done("failed", "draft agent read-back: the response engine changed; not published");
    say(`draft agent read-back: webhook_url ${hookUrl}; every other setting equal to published v${pubV}`);
    // 5. Publish exactly that draft, then read the published version back.
    const pubDo = await call("POST", `/publish-agent-version/${A}`, { version: draftV, version_title: `Production routing (v${pubV} + production URLs)` });
    if (!pubDo.ok) return done("failed", `Retell refused to publish draft v${draftV} (${pubDo.error}); callers still use v${pubV}`);
    const liveR = await call("GET", `/get-agent/${A}?version=${draftV}`);
    const live = liveR.json;
    const liveLlmV = num(obj(live.response_engine).version);
    const liveLlmR = await call("GET", `/get-retell-llm/${L}${liveLlmV !== null ? `?version=${liveLlmV}` : ""}`);
    if (!liveR.ok || live.is_published !== true || str(live.webhook_url) !== hookUrl) return done("failed", `published, but v${draftV} does not read back as published with the target webhook: check in Retell`);
    if (!liveLlmR.ok || arr(liveLlmR.json.general_tools).map(obj).some((t) => str(t.type) === "custom" && str(t.url) !== null && str(t.url) !== fnUrl)) return done("failed", `published v${draftV}, but its LLM tools do not all read back on the target: check in Retell`);
    say(`published agent v${draftV} (LLM v${liveLlmV ?? "?"}): webhook ${hookUrl}; ${customTools.length} tool url(s) ${fnUrl} (read back)`);
    newV = draftV;
  }

  // 6. Numbers last, so a call's first webhook reaches the target only once the agent's own traffic does. A number
  //    pinned to an explicit older version is moved to the new one.
  for (const p of numberPlans) {
    const pins = arr(p.n.inbound_agents).map(obj);
    const pinned = pins.some((a) => str(a.agent_id) === o.agentId && a.agent_version !== undefined && a.agent_version !== null && num(Number(a.agent_version)) !== null && Number(a.agent_version) !== newV);
    const change = !("refuse" in p.r) && p.r.change;
    if (!change && !pinned) continue;
    const body: Obj = { inbound_webhook_url: inUrl };
    if (pinned) body.inbound_agents = pins.map((a) => (str(a.agent_id) === o.agentId && num(Number(a.agent_version)) !== null ? { ...a, agent_version: newV } : a));
    const P = encodeURIComponent(str(p.n.phone_number) ?? "");
    const up = await call("PATCH", `/update-phone-number/${P}`, body);
    if (!up.ok) return done("failed", `number ${last4(p.n.phone_number)}: Retell refused the update (${up.error}); the agent is already on ${o.to}`);
    const back = await call("GET", `/get-phone-number/${P}`);
    const b = back.ok ? back.json : obj(items((await call("GET", "/v2/list-phone-numbers?limit=100")).raw).map(obj).find((x) => str(x.phone_number) === str(p.n.phone_number)));
    if (str(b.inbound_webhook_url) !== inUrl) return done("failed", `number ${last4(p.n.phone_number)}: read-back shows ${str(b.inbound_webhook_url) ?? "(none)"}`);
    const binding = arr(b.inbound_agents).map(obj).find((a) => str(a.agent_id) === o.agentId);
    say(`number ${last4(p.n.phone_number)}: inbound webhook ${inUrl}; agent ${o.agentId} ${binding?.agent_version !== undefined && binding?.agent_version !== null ? `pinned to v${String(binding.agent_version)}` : "on its latest published version"} (read back)`);
  }
  say(`routed: the receptionist's inbound calls, call events and function calls go to ${o.to}`);
  return { status: "routed", lines };
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
