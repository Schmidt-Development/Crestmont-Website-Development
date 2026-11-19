// Renders the production Worker's native-readiness answers (/api/ops/portfolio-native) as Markdown for the job summary.
// The answers contain names and identifiers only — never a token (src/services/native/verify-connections.ts).
//   node scripts/native-ops-report.mjs check|step <answer.json>
//   node scripts/native-ops-report.mjs status <project.json> <audit.json>   (wrangler d1 --json output; read-only)
// status also reads, read-only: Crestmont's Cloudflare rule (GET with CLOUDFLARE_API_TOKEN when that token may read the
// zone's rulesets) and the live site's framing headers on its homepage and protected pages, like a visitor.
import { readFileSync, appendFileSync } from "node:fs";
const [mode, file, file2] = process.argv.slice(2);
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
} else if (mode === "status") {
  const rows = (x) => (Array.isArray(x) ? x.flatMap((y) => y.results ?? []) : x.results ?? []);
  const p = rows(r)[0];
  const audit = rows(JSON.parse(readFileSync(file2, "utf8")));
  const out = ["### Production state (read-only)"];
  if (!p) { out.push("No portfolio entry with this slug."); console.log(out.join("\n")); process.exit(0); }
  const change = (() => { try { return JSON.parse(p.native_change ?? "null"); } catch { return null; } })();
  const ver = (() => { try { return JSON.parse(p.native_verification ?? "null"); } catch { return null; } })();
  out.push(`- **${p.slug}** (${p.id}) — ${p.live_url} · published: ${p.published ? "yes" : "no"} · native required: ${p.native_required ? "yes" : "no"}`);
  out.push(`- state: **${p.native_state}** (updated ${p.native_updated_at ?? "?"}; verified at ${p.native_verified_at ?? "never"})`);
  out.push(`- reason: ${String(p.native_reason ?? "").replace(/\n/g, " ")}`);
  out.push(`- hosting: ${p.native_provider ?? "—"}`);
  out.push(`- change: ${change ? `\`${JSON.stringify(change)}\`` : "none"}`);
  if (ver) { out.push(`- last browser verification: ${ver.ok ? "passed" : "failed"} at ${ver.at} — ${ver.summary ?? ""}`); for (const c of ver.checks ?? []) out.push(`  - ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`); }
  out.push("\n**Audit trail (newest first)**");
  for (const a of audit) out.push(`- ${a.created_at} · ${a.actor_kind} · ${a.action} · ${String(a.details ?? "").replace(/\|/g, "/")}`);
  // Crestmont's rule as Cloudflare holds it now (GET only).
  if (change?.kind === "cloudflare-rule" && process.env.CLOUDFLARE_API_TOKEN && /^[0-9a-f]{32}$/.test(change.zoneId ?? "") && /^[0-9a-f]{32}$/.test(change.rulesetId ?? "")) {
    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${change.zoneId}/rulesets/${change.rulesetId}`, { headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } });
      if (res.ok) {
        const rs = (await res.json()).result;
        const mine = (rs?.rules ?? []).filter((x) => x.ref === change.ref);
        out.push(`\n**Crestmont's Cloudflare rule (read now):** ${mine.length === 0 ? "not present (removed)" : mine.length === 1 ? "present" : `**${mine.length} copies**`} · other rules in the phase: ${(rs?.rules ?? []).length - mine.length}`);
        for (const m of mine) out.push(`- id ${m.id} · enabled ${m.enabled !== false} · action ${m.action}\n- expression: \`${m.expression}\`\n- headers: \`${JSON.stringify(m.action_parameters?.headers ?? {})}\``);
      } else out.push(`\n**Crestmont's Cloudflare rule:** this workflow's deployment token cannot read the zone's rulesets (HTTP ${res.status}); its presence is judged from the live headers below.`);
    } catch (e) { out.push(`\n**Crestmont's Cloudflare rule:** not read (${e.message})`); }
  }
  // The live site's headers, as a visitor reads them.
  out.push("\n**Live framing headers (visitor GET)**\n\n| Path | HTTP | frame-ancestors | X-Frame-Options |\n|---|---|---|---|");
  for (const path of ["/", "/login", "/account", "/apply", "/application", "/checkout", "/payment"]) {
    try {
      const res = await fetch(new URL(path, p.live_url), { redirect: "manual" });
      await res.body?.cancel();
      const fa = (res.headers.get("content-security-policy") ?? "").split(",").flatMap((x) => x.split(";").map((d) => d.trim())).filter((d) => /^frame-ancestors/i.test(d));
      out.push(`| ${path} | ${res.status} | ${fa.join("; ") || "—"} | ${res.headers.get("x-frame-options") ?? "—"} |`);
    } catch (e) { out.push(`| ${path} | error | ${e.message} | |`); }
  }
  console.log(out.join("\n"));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `live=${p.live_url}\nstate=${p.native_state}\n`);
} else {
  console.log(`- **${r.slug}**: ${r.state}${r.converted ? " (converted from the acceptance entry)" : r.created ? " (created, unpublished)" : ""}${r.provider ? ` · hosting: ${r.provider}` : ""} — ${String(r.reason).replace(/\n/g, " ")}`);
  for (const c of r.verification?.checks ?? []) console.log(`  - ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
}
