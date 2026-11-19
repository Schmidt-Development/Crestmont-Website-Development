// Renders the production Worker's native-readiness answers (/api/ops/portfolio-native) as Markdown for the job summary.
// The answers contain names and identifiers only — never a token (src/services/native/verify-connections.ts).
//   node scripts/native-ops-report.mjs check|step <answer.json>
import { readFileSync } from "node:fs";
const [mode, file] = process.argv.slice(2);
const r = JSON.parse(readFileSync(file, "utf8"));
const list = (xs) => (Array.isArray(xs) && xs.length ? xs.map((x) => `  - ${typeof x === "string" ? x : JSON.stringify(x)}`).join("\n") : "  - (none)");
if (mode === "check") {
  const out = [`### Native onboarding connections (production Worker, ${r.origin})`];
  for (const [name, p] of Object.entries(r.connections).filter(([k]) => k !== "at")) {
    out.push(`\n**${name}** — ${!p.connected ? "NOT CONNECTED (secret not set)" : p.authenticated ? `authenticated as ${p.identity}` : "**FAILED to authenticate**"}`);
    for (const [k, v] of Object.entries(p.scope ?? {})) out.push(`- ${k}:${Array.isArray(v) ? `\n${list(v)}` : typeof v === "object" ? `\n${list(Object.entries(v).map(([a, b]) => `${a}: ${typeof b === "string" ? b : JSON.stringify(b)}`))}` : ` ${v}`}`);
    if (p.missing?.length) out.push(`- **missing permissions:**\n${list(p.missing)}`);
    if (p.errors?.length) out.push(`- errors:\n${list(p.errors)}`);
  }
  out.push("\n### Discovery (read-only: nothing was changed)\n\n| Address | Framing answer | Served by a connected account? |\n|---|---|---|");
  for (const d of r.discovery ?? []) out.push(`| ${d.url} | ${d.status}: ${String(d.detail).replace(/\|/g, "/")} | ${d.hosting ? `${d.hosting.found ? "**yes**" : "no"} — ${String(d.hosting.detail).replace(/\|/g, "/")}` : "—"} |`);
  console.log(out.join("\n"));
} else {
  console.log(`- **${r.slug}**: ${r.state}${r.converted ? " (converted from the acceptance entry)" : r.created ? " (created, unpublished)" : ""}${r.provider ? ` · hosting: ${r.provider}` : ""} — ${String(r.reason).replace(/\n/g, " ")}`);
  for (const c of r.verification?.checks ?? []) console.log(`  - ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
}
