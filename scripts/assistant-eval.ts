// Accuracy check of the live website assistant (Founder, 2026-11-10): real questions a customer asks, sent to the deployed
// assistant exactly as the chat widget sends them, each answer checked against Crestmont's published facts. About 11
// assistant calls, spaced to stay within the assistant's own per-visitor rate limit. Prints questions and answers only.
//   node --no-warnings scripts/assistant-eval.ts --base https://<host>
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const base = (args[args.indexOf("--base") + 1] ?? "").replace(/\/+$/, "");
if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(base)) { console.error("--base https://<host> is required"); process.exit(2); }
type Turn = { role: "user" | "assistant"; content: string };
const session = `eval-${Date.now().toString(36)}`;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function ask(messages: Turn[]): Promise<{ status: number; reply: string; links: string[] }> {
  const r = await fetch(`${base}/api/assistant`, { method: "POST", headers: { "content-type": "application/json", origin: base, "x-assistant-session": session }, body: JSON.stringify({ messages }), signal: AbortSignal.timeout(60_000) });
  const j = await r.json().catch(() => ({})) as { reply?: string; links?: string[]; message?: string };
  return { status: r.status, reply: j.reply ?? j.message ?? "", links: j.links ?? [] };
}
const otherDollars = (t: string) => [...t.matchAll(/\$\d[\d,]*(?:\.\d{2})?(?!\d)(\s*(?:\/|per|a)\s*month)?/gi)].filter((m) => !m[1]).map((m) => m[0].trim()).filter((d) => !["$999", "$2,499", "$4,999"].includes(d));
// The published maintenance prices, read from the live site itself, so the assistant is checked against what customers see.
const page = await fetch(`${base}/hosting-maintenance`, { signal: AbortSignal.timeout(20_000) }).then((r) => r.text()).catch(() => "");
const published = Object.fromEntries(["essential", "professional", "executive"].map((id) => [id, new RegExp(`data-testid="price-${id}">(\\$[\\d,]+(?:\\.\\d{2})?)`).exec(page)?.[1] ?? null]));
console.log(`published maintenance prices: ${JSON.stringify(published)}`);
const cases: { q: string; follow?: string; check: (reply: string, links: string[]) => string | null }[] = [
  { q: "How much does the Starter website package cost?", check: (r) => (/\$999\b/.test(r) ? null : "Starter price $999 missing") },
  { q: "What is the price of the Business package?", check: (r) => (/\$2,499\b/.test(r) ? null : "Business price $2,499 missing") },
  { q: "How much is Premium, and what if I need more than Premium includes?", check: (r) => (/\$4,999/.test(r) && /quote|custom/i.test(r) ? null : "Premium $4,999 and the custom-quote route for larger scope expected") },
  { q: "What does Business include that Starter does not?", check: (r) => (/Starter[^.]{0,60}includes everything in (the )?(Business|Premium)/i.test(r) ? "inverted comparison: says Starter includes a larger package" : /12 pages|pages/i.test(r) ? null : "expected Business additions (e.g. up to 12 pages)") },
  { q: "Do you have any discounts or coupon codes right now?", check: (r) => (/\d+\s?%\s?off|\$\d[\d,]*\s?off|coupon code is/i.test(r) ? "invented a discount" : null) },
  { q: "Can you guarantee my website will be finished in two weeks?", check: (r) => (/\b(yes|we (can )?guarantee|guaranteed (delivery|launch|completion))\b/i.test(r) && !/not|cannot|can't|don't/i.test(r) ? "promised a delivery date" : null) },
  { q: "How do I buy the Business package?", check: (r, l) => (l.some((x) => /^\/(checkout\/business|pricing)/.test(x)) || /\/checkout\/business|\/pricing/.test(r) ? null : "no link into the purchase journey") },
  { q: "How much would a custom web application cost?", check: (r) => (otherDollars(r).length ? `quoted a price for custom work (${otherDollars(r).join(", ")})` : /quote/i.test(r) ? null : "custom work should be routed to a quote") },
  { q: "Do I have to pay for a maintenance plan, and what do the plans cost?", check: (r) => {
    if (!(/plan/i.test(r) && /(minimum|requires?|required)/i.test(r))) return "the required minimum maintenance plan was not explained";
    const quoted = [...r.matchAll(/\$[\d,]+(?:\.\d{2})?(?=\s*(?:\/|per|a)\s*month)/gi)].map((m) => m[0]);
    const known = Object.values(published).filter(Boolean) as string[];
    if (!known.length) return "could not read the published maintenance prices from /hosting-maintenance";
    const wrong = quoted.filter((q) => !known.includes(q));
    return wrong.length ? `maintenance prices differ from the published ones (${wrong.join(", ")} vs ${known.join(", ")})` : null;
  } },
  { q: "If I'm unhappy after launch can I get a full refund?", check: (r) => (/\b(yes|absolutely|of course)\b[^.]{0,40}(full )?refund/i.test(r) ? "invented a refund promise" : null) },
  { q: "I'm comparing the packages.", follow: "Which one is the cheapest, and how many revision rounds does it have?", check: (r) => (/Starter/.test(r) && /\$999/.test(r) && /\b2\b|two/i.test(r) ? null : "multi-turn follow-up: Starter $999 with 2 revision rounds expected") },
];
const rows: string[] = [];
let failed = 0;
for (const c of cases) {
  let turns: Turn[] = [{ role: "user", content: c.q }];
  let a = await ask(turns);
  if (c.follow && a.status === 200) { await pause(16_000); turns = [...turns, { role: "assistant", content: a.reply }, { role: "user", content: c.follow }]; a = await ask(turns); }
  const problem = a.status !== 200 ? `HTTP ${a.status}: ${a.reply}` : otherDollars(a.reply).length && !/custom/i.test(c.q) ? `unpublished amount ${otherDollars(a.reply).join(", ")}` : c.check(a.reply, a.links);
  if (problem) failed++;
  const q = c.follow ? `${c.q} → ${c.follow}` : c.q;
  console.log(`${problem ? "✖" : "✔"} Q: ${q}\n   A: ${a.reply.replace(/\s+/g, " ").slice(0, 400)}${a.links.length ? `\n   links: ${a.links.join(", ")}` : ""}${problem ? `\n   problem: ${problem}` : ""}`);
  rows.push(`| ${problem ? "FAIL" : "PASS"} | ${q.replace(/\|/g, "/")} | ${a.reply.replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, 220)} | ${problem ?? ""} |`);
  await pause(16_000); // the assistant allows 8 messages per 2 minutes per visitor
}
const summary = `${cases.length - failed}/${cases.length} assistant accuracy checks passed on ${base}`;
console.log(`\n${summary}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Website assistant accuracy\n\n| Result | Question | Answer (excerpt) | Problem |\n|---|---|---|---|\n${rows.join("\n")}\n\n${summary}\n`);
console.log(`::${failed ? "error" : "notice"} title=Website assistant accuracy::${summary}`);
process.exit(failed ? 1 : 0);
