// Strict native-readiness gate (Owner, 2026-11-19): the portfolio is native-ready only when EVERY required entry —
// every published entry, plus the named acceptance slugs — is native_verified. A fallback notice is honest, but it is
// not success: an entry that is not verified fails this gate, with its exact state, diagnosis and the one action
// needed (a genuine authorization or provider blocker is named as such).
//   node scripts/native-readiness-gate.mjs <readiness.json> [slug,slug,…]
import { readFileSync } from "node:fs";

const [file, named = ""] = process.argv.slice(2);
const r = JSON.parse(readFileSync(file, "utf8"));
const want = new Set(named.split(",").map((s) => s.trim()).filter(Boolean));
const rows = r.readiness ?? [];
const required = rows.filter((x) => x.published || want.has(x.slug));
for (const s of want) if (!rows.some((x) => x.slug === s)) required.push({ slug: s, name: s, published: false, state: "missing", reason: "no portfolio entry with this slug", codes: [], action: null });
console.log("| Entry | Published | Native state | Diagnosis | What is needed |\n|---|---|---|---|---|");
let failed = 0;
for (const x of required) {
  const ok = x.state === "native_verified";
  if (!ok) failed++;
  console.log(`| ${ok ? "✓" : "✗"} ${x.name} (${x.slug}) | ${x.published ? "yes" : "no"} | ${x.state} | ${(x.codes ?? []).join(", ") || "—"} | ${ok ? "—" : (x.action ?? x.reason ?? "").replace(/\|/g, "/").slice(0, 300)} |`);
}
// Measured performance (lab: Browser Run, the environment recorded with each measurement) — a diagnosis, not a
// guarantee: what the website does on its own (direct) and inside Crestmont (embedded).
const m = (x) => !x ? "—" : `LCP ${x.lcp ?? "—"} ms · CLS ${x.cls ?? "—"} · TBT ${x.tbt ?? "—"} ms · ${x.idleFps ?? "—"} fps idle${x.scrollFps != null ? ` · ${x.scrollFps} fps scrolling` : ""}${x.interaction != null ? ` · click ${x.interaction} ms` : ""}`;
const measured = rows.filter((x) => x.perf);
if (measured.length) {
  console.log("\n| Entry | Direct (the site on its own) | Embedded (in Crestmont) | Verdict | Environment | Measured |\n|---|---|---|---|---|---|");
  for (const x of measured) console.log(`| ${x.name} | ${m(x.perf.direct)} | ${m(x.perf.embedded)} | ${(x.perf.verdict ?? "—").replace(/\|/g, "/")} | ${(x.perf.environment ?? "—").replace(/\|/g, "/")} | ${x.perf.at ?? "—"} |`);
}
const others = rows.filter((x) => !required.includes(x));
if (others.length) console.log(`\nNot required here (unpublished, not named): ${others.map((x) => `${x.slug} (${x.state})`).join(", ")}`);
console.log(failed ? `\nFAIL ${failed} of ${required.length} required entr${required.length === 1 ? "y is" : "ies are"} not native-verified` : `\nPASS all ${required.length} required entries are native-verified`);
process.exit(failed ? 1 : 0);
