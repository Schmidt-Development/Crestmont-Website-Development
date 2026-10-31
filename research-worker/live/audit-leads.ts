// Independent quality audit of the leads a live research run promoted into the CRM.
// Input: the decrypted details.json of a research-live-sample run (sealed artifact; decrypted only inside the workflow).
// Method (deliberately different from the research pipeline): a fresh fetch at a different time, plus a real Chromium
// render at desktop 1366x900 and phone 390x844 (JavaScript executed), from which identity and every claimed finding are
// re-tested one by one. Nothing is clicked or submitted; robots.txt is honoured; private addresses are refused.
//
// Classification rubric (applied mechanically; written in docs/research/AUDIT.md):
//   D invalid:  duplicate of another promoted lead · rendered page contradicts the business (different phone, no shared
//               signal) · a "broken" claim that no longer reproduces · every testable material claim refuted
//   A strong:   still broken on re-check (listed site) · a supported high-severity problem (no mobile viewport / sideways
//               scroll / no HTTPS / insecure form / many broken links) on a site whose identity re-confirms
//   B moderate: at least one supported material claim · or "no website found" that survives a wider name-derived probe
//               AND whose existence is corroborated by an independent online profile listed for the business
//   C weak:     claims could not be re-tested (insufficient evidence), or "no website found" with existence resting on
//               the dataset alone, or only minor problems reproduce
//   (D also: a "no website" claim refuted by finding the business's own site.)
// Commercial fit (budget, intent, decision-maker) is NOT machine-assessable and is not inferred.
//
// Public output: aggregate counts only. Per-lead audit: sealed by the workflow.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Http } from "../src/http.ts";
import { Browser, type RenderedPage } from "../src/browser.ts";
import { pageFacts, identity, parkedPage } from "../src/identity.ts";
import { probeDomains } from "../src/pipeline.ts";
import { normDomain, normName, phoneE164, recommendPackage, isCandidateOfficialDomain, type WebsiteClass, type Finding as DomainFinding } from "../../src/domain/research.ts";
import type { Candidate } from "../src/sources/types.ts";
import { snapshot } from "../src/resources.ts";

interface Finding { code: string; title: string; severity: string; confidence: number; url: string; evidence: string }
interface Detail {
  businessKey: string; name: string; address: { line: string | null; city: string | null; state: string | null; zip: string | null }; phone: string | null; listedWebsites: string[];
  classification: string; websiteUrl: string | null; identitySignals: string[]; findings: Finding[];
  platform: { status: string; score: number; recommended_package?: string | null; website_class: string } | null;
}
type Verdict = "supported" | "not_supported" | "not_testable";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg("out", "audit-out")!;
mkdirSync(OUT, { recursive: true });
const details = JSON.parse(readFileSync(arg("details", "in/details.json")!, "utf8")) as Detail[];
const leads = details.filter((d) => d.platform?.status === "promoted");
const UA = "CrestmontResearchBot/0.1 (+https://crestmontwebsitedevelopment.com; support@crestmontwebsitedevelopment.com) audit";
const http = new Http({ userAgent: UA, robotsToken: "CrestmontResearchBot", timeoutMs: 20_000, perHostIntervalMs: 5_000, concurrency: 8, maxBytes: 3_000_000 });
const browser = await Browser.open(UA);
if (!browser) throw new Error("Playwright Chromium is required for the audit (set PLAYWRIGHT_MODULE)");
const MATERIAL = (f: Finding) => f.confidence >= 0.6 && f.severity !== "low";
const HIGH = new Set(["no_viewport_meta", "no_https", "insecure_form", "mobile_horizontal_scroll"]);
const r0 = await snapshot(process.cwd());
const started = Date.now();

// ── duplicates among the promoted leads (phone, website host, name + street) ──
const seen = new Map<string, string>();
const duplicateOf = new Map<string, string>();
for (const d of leads) {
  const keys = [d.phone ? `p:${phoneE164(d.phone)}` : null, d.websiteUrl ? `w:${normDomain(d.websiteUrl)}` : null, d.address.line ? `n:${normName(d.name)}|${(d.address.line ?? "").toLowerCase()}` : null].filter((k): k is string => !!k);
  for (const k of keys) { const prev = seen.get(k); if (prev && prev !== d.businessKey && !duplicateOf.has(d.businessKey)) duplicateOf.set(d.businessKey, prev); else seen.set(k, d.businessKey); }
}

async function testClaim(f: Finding, ctx: { fresh: Awaited<ReturnType<Http["get"]>>; desk: RenderedPage; mob: RenderedPage; rendered: ReturnType<typeof pageFacts> | null }): Promise<{ verdict: Verdict; how: string }> {
  const { fresh, desk, mob, rendered } = ctx;
  const live = desk.ok && (desk.status ?? 0) < 400;
  switch (f.code) {
    case "http_404": case "http_5xx": case "site_dns": case "site_refused": case "site_timeout": case "site_tls": case "site_reset": case "site_other": case "listed_domain_parked": {
      const stillFailing = !!fresh.error || (fresh.status !== null && fresh.status >= 400 && ![401, 403, 429].includes(fresh.status));
      const parked = live && rendered ? !!parkedPage(rendered) : false;
      if (fresh.robotsBlocked || [401, 403, 429].includes(fresh.status ?? 0)) return { verdict: "not_testable", how: "re-check restricted (robots/401/403/429)" };
      return stillFailing || parked ? { verdict: "supported", how: `re-fetch: ${fresh.error?.kind ?? `HTTP ${fresh.status}`}${parked ? " (placeholder page)" : ""}` } : { verdict: "not_supported", how: `re-fetch now HTTP ${fresh.status}; renders ${desk.textLength} chars` };
    }
    case "no_viewport_meta": if (!mob.ok) return { verdict: "not_testable", how: "mobile render failed" };
      return !mob.viewportMeta || mob.scrollWidth - mob.innerWidth > 8 ? { verdict: "supported", how: `rendered at 390px: viewport tag ${mob.viewportMeta ? "present" : "absent"}, width ${mob.scrollWidth}px` } : { verdict: "not_supported", how: "viewport tag present and no sideways scroll at 390px" };
    case "images_without_alt": if (!live) return { verdict: "not_testable", how: "render failed" };
      return desk.images >= 5 && desk.imagesNoAlt / desk.images > 0.5 ? { verdict: "supported", how: `${desk.imagesNoAlt}/${desk.images} rendered images without alt` } : { verdict: "not_supported", how: `${desk.imagesNoAlt}/${desk.images} rendered images without alt` };
    case "obsolete_markup": if (!live) return { verdict: "not_testable", how: "render failed" };
      return /<frameset|\.swf["'\s]|<marquee|<font\b/i.test(desk.html) ? { verdict: "supported", how: "obsolete element present in rendered DOM" } : { verdict: "not_supported", how: "not present in rendered DOM" };
    case "mixed_content": if (!live) return { verdict: "not_testable", how: "render failed" };
      return desk.httpResources > 0 ? { verdict: "supported", how: `${desk.httpResources} resource(s) loaded over http` } : { verdict: "not_supported", how: "no http resources loaded by the browser" };
    case "redirect_chain": return fresh.chain.length > 3 ? { verdict: "supported", how: `${fresh.chain.length - 1} redirects on re-fetch` } : fresh.error ? { verdict: "not_testable", how: "re-fetch failed" } : { verdict: "not_supported", how: `${Math.max(0, fresh.chain.length - 1)} redirect(s) on re-fetch` };
    case "missing_title": if (!live) return { verdict: "not_testable", how: "render failed" };
      return desk.title.trim() ? { verdict: "not_supported", how: "rendered page has a title" } : { verdict: "supported", how: "rendered page has no title" };
    case "slow_response": {
      const t = Math.max(fresh.responseMs ?? 0, desk.responseMs ?? 0);
      return t > 4000 ? { verdict: "supported", how: `${t} ms on re-check` } : fresh.error && !desk.ok ? { verdict: "not_testable", how: "re-check failed" } : { verdict: "not_supported", how: `${t} ms on re-check` };
    }
    case "insecure_form": if (!live) return { verdict: "not_testable", how: "render failed" };
      return desk.insecureForms > 0 ? { verdict: "supported", how: `${desk.insecureForms} form(s) post to http` } : { verdict: "not_supported", how: "no form posts to http in rendered DOM" };
    case "no_https": {
      const host = normDomain(f.url);
      const s = host ? await http.get(`https://${host}/`) : null;
      if (!s || s.robotsBlocked) return { verdict: "not_testable", how: "https re-check not possible" };
      return s.error || s.finalUrl.startsWith("http:") ? { verdict: "supported", how: `https: ${s.error?.kind ?? `ends at ${s.finalUrl.split(":")[0]}`}` } : { verdict: "not_supported", how: `https works (HTTP ${s.status})` };
    }
    case "broken_internal_links": {
      const urls = [...f.evidence.matchAll(/(https?:\/\/\S+?) →/g)].map((m) => m[1]).slice(0, 6);
      if (!urls.length) return { verdict: "not_testable", how: "no link list in evidence" };
      let bad = 0, tested = 0;
      for (const u of urls) { const r = await http.get(u); if (r.robotsBlocked) continue; tested++; if (r.status === 404 || r.status === 410 || (r.status ?? 0) >= 500 || (r.error && r.error.kind !== "blocked_address")) bad++; }
      return !tested ? { verdict: "not_testable", how: "links restricted" } : bad ? { verdict: "supported", how: `${bad}/${tested} links still broken` } : { verdict: "not_supported", how: `0/${tested} links broken now` };
    }
    case "no_contact_method": if (!live || !rendered) return { verdict: "not_testable", how: "render failed" };
      return rendered.phones.length || /href=["']mailto:|<form/i.test(desk.html) ? { verdict: "not_supported", how: "contact details present in rendered page" } : { verdict: "supported", how: "no phone, mailto or form in rendered page" };
    case "missing_h1": if (!rendered) return { verdict: "not_testable", how: "render failed" }; return rendered.h1 ? { verdict: "not_supported", how: "rendered h1 present" } : { verdict: "supported", how: "no rendered h1" };
    case "missing_meta_description": if (!live) return { verdict: "not_testable", how: "render failed" }; return /<meta[^>]+name=["']description["']/i.test(desk.html) ? { verdict: "not_supported", how: "present in rendered DOM" } : { verdict: "supported", how: "absent in rendered DOM" };
    case "missing_lang": if (!live) return { verdict: "not_testable", how: "render failed" }; return /<html[^>]+lang=/i.test(desk.html) ? { verdict: "not_supported", how: "lang present" } : { verdict: "supported", how: "lang absent" };
    default: return { verdict: "not_testable", how: "no independent test for this finding" };
  }
}

interface Audit {
  businessKey: string; name: string; location: string; website: string | null; researchClass: string; researchScore: number; recommendedPackage: string | null;
  operational: boolean | null; mobileFriendly: boolean | null; identity: "confirmed" | "weak" | "contradicted" | "no_website" | "not_testable";
  claims: { code: string; severity: string; material: boolean; verdict: Verdict; how: string }[]; evidenceUrls: string[];
  duplicateOf: string | null; category: "A" | "B" | "C" | "D"; confidence: "high" | "medium" | "low"; explanation: string;
}

async function auditOne(d: Detail): Promise<Audit> {
  const base = { businessKey: d.businessKey, name: d.name, location: [d.address.line, d.address.city, d.address.state].filter(Boolean).join(", "), website: d.websiteUrl,
    researchClass: d.classification, researchScore: d.platform?.score ?? 0,
    recommendedPackage: d.platform?.recommended_package ?? recommendPackage(d.classification as WebsiteClass, d.findings.filter(MATERIAL) as unknown as DomainFinding[]), duplicateOf: duplicateOf.get(d.businessKey) ?? null };
  if (base.duplicateOf) return { ...base, operational: null, mobileFriendly: null, identity: "not_testable", claims: [], evidenceUrls: [], category: "D", confidence: "high", explanation: "Duplicate of another promoted lead (same phone, website or name and street)." };
  if (!d.websiteUrl) {
    // The "no website" claim is tested by trying to falsify it: a wider set of name-derived domains than the pipeline
    // uses (.com/.net/.biz/.us, with and without the city), rendered in a real browser. A site whose rendered page shows
    // this business's phone or street refutes the claim (D). Existence is corroborated only by an independent online
    // profile listed for the business (social / directory page). Otherwise the evidence is insufficient (C).
    const stems = probeDomains(d.name).map((x) => x.replace(/\.com$/, ""));
    const city = (d.address.city ?? "").toLowerCase().replace(/[^a-z]/g, "");
    const variants = [...new Set(stems.flatMap((s) => [s, city && s.length + city.length <= 40 ? `${s}${city}` : null]).filter((x): x is string => !!x).flatMap((s) => ["com", "net", "biz", "us"].map((t) => `${s}.${t}`)))].slice(0, 10);
    const cand = { businessKey: d.businessKey, name: d.name, category: null, address: d.address, lat: null, lon: null, phones: d.phone ? [phoneE164(d.phone)!].filter(Boolean) : [], emails: [], websites: [], sources: [], sourceConfidence: null, operatingStatus: null } as Candidate;
    const tried: string[] = [];
    for (const v of variants) {
      const r = await http.get(`https://${v}/`);
      if (r.error || r.robotsBlocked || (r.status ?? 500) >= 400) continue;
      tried.push(v);
      const page = await browser!.inspect(`https://${v}/`, { width: 1366, height: 900, mobile: false });
      const facts = page.ok && page.html ? pageFacts(page.html) : pageFacts(r.body);
      const id = identity(cand, facts, []);
      if (id.official && id.signals.some((x) => /phone|street/.test(x))) {
        return { ...base, operational: true, mobileFriendly: null, identity: "contradicted", claims: [{ code: "no_official_website", severity: "high", material: true, verdict: "not_supported", how: `found ${v}: ${id.signals.join("; ")}` }],
          evidenceUrls: [`https://${v}/`], category: "D", confidence: "high", explanation: `False "no website": the business's own site exists at ${v} (${id.signals.join("; ")}).` };
      }
    }
    const profiles = [...d.listedWebsites.map((w) => normDomain(w)).filter((x): x is string => !!x && !isCandidateOfficialDomain(x)),
      ...d.identitySignals.filter((x) => /^listed by \d+ independent datasets/.test(x))];
    const claim = { code: "no_official_website", severity: "high", material: true, verdict: "not_testable" as Verdict, how: `${variants.length} name-derived domains tried, ${tried.length} loaded, none showed this business's phone or street; absence of a website cannot be proven` };
    if (profiles.length) return { ...base, operational: null, mobileFriendly: null, identity: "no_website", claims: [claim], evidenceUrls: d.listedWebsites.slice(0, 3), category: "B", confidence: "low",
      explanation: `No website found (falsification probe negative); existence corroborated by ${[...new Set(profiles)].join("; ")}. Moderate: absence of a website is not proven.` };
    return { ...base, operational: null, mobileFriendly: null, identity: "no_website", claims: [claim], evidenceUrls: [], category: "C", confidence: "low",
      explanation: "No website found and none could be found by a wider name-derived probe, but existence rests on the open dataset alone: insufficient independent evidence." };
  }
  const fresh = await http.get(d.websiteUrl);
  const canRender = !fresh.robotsBlocked && !(fresh.error?.kind === "blocked_address");
  const desk = canRender ? await browser!.inspect(d.websiteUrl, { width: 1366, height: 900, mobile: false }) : { ok: false } as RenderedPage;
  const mob = canRender ? await browser!.inspect(d.websiteUrl, { width: 390, height: 844, mobile: true }) : { ok: false } as RenderedPage;
  const rendered = desk.ok && desk.html ? pageFacts(desk.html) : null;
  const cand = { businessKey: d.businessKey, name: d.name, category: null, address: d.address, lat: null, lon: null, phones: d.phone ? [phoneE164(d.phone)!].filter(Boolean) : [], emails: [], websites: d.listedWebsites, sources: [], sourceConfidence: null, operatingStatus: null } as Candidate;
  const listed = d.listedWebsites.some((w) => normDomain(w) === normDomain(d.websiteUrl));
  const id = rendered ? identity(cand, rendered, listed ? ["overture"] : []) : null;
  const idState: Audit["identity"] = !rendered ? "not_testable" : id!.official ? "confirmed" : id!.contradictions.length ? "contradicted" : "weak";
  const operational = desk.ok ? (desk.status ?? 0) < 400 && desk.textLength > 40 : fresh.error ? false : null;
  const mobileFriendly = mob.ok ? mob.viewportMeta && mob.scrollWidth - mob.innerWidth <= 8 : null;
  const claims: Audit["claims"] = [];
  for (const f of d.findings) { const t = await testClaim(f, { fresh, desk, mob, rendered }); claims.push({ code: f.code, severity: f.severity, material: MATERIAL(f), ...t }); }
  const mat = claims.filter((c) => c.material);
  const sup = mat.filter((c) => c.verdict === "supported"), ref = mat.filter((c) => c.verdict === "not_supported");
  const broken = d.classification === "VERIFIED_WEBSITE_BROKEN";
  const evidenceUrls = [...new Set([d.websiteUrl, ...d.findings.map((f) => f.url)])].slice(0, 6);
  const out = (category: Audit["category"], confidence: Audit["confidence"], explanation: string): Audit => ({ ...base, operational, mobileFriendly, identity: idState, claims, evidenceUrls, category, confidence, explanation });
  if (idState === "contradicted" && !broken) return out("D", "medium", "The rendered page shows contact details of a different business; the website match is not confirmed.");
  if (broken) {
    if (sup.length) return out("A", listed ? "high" : "medium", `Still broken on independent re-check (${sup.map((c) => c.how).join("; ")}). Listed as the business's website by the dataset.`);
    if (ref.length) return out("D", "high", `The "broken" claim did not reproduce: ${ref.map((c) => c.how).join("; ")}.`);
    return out("C", "low", "The broken-site claim could not be re-tested (access restricted): insufficient evidence.");
  }
  if (!sup.length && ref.length) return out("D", "high", `No material claim reproduced: ${ref.map((c) => `${c.code} (${c.how})`).join("; ")}.`);
  if (!sup.length) return out("C", "low", "Material claims could not be independently re-tested: insufficient evidence.");
  const high = sup.filter((c) => HIGH.has(c.code) || c.severity === "high" || c.severity === "critical");
  if (high.length && idState === "confirmed") return out("A", "high", `Supported high-severity problem(s) on a confirmed business website: ${high.map((c) => `${c.code} (${c.how})`).join("; ")}.`);
  if (sup.length >= 2 && idState === "confirmed" && mobileFriendly === false) return out("A", "medium", `Several supported problems and not mobile-friendly: ${sup.map((c) => c.code).join(", ")}.`);
  return out("B", idState === "confirmed" ? "medium" : "low", `Supported problem(s): ${sup.map((c) => `${c.code} (${c.how})`).join("; ")}${ref.length ? `; refuted: ${ref.map((c) => c.code).join(", ")}` : ""}${idState !== "confirmed" ? "; identity only weakly re-confirmed" : ""}.`);
}

// Bounded concurrency; each host is still paced by Http.
const results: Audit[] = [];
let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => { while (next < leads.length) { const d = leads[next++]; try { results.push(await auditOne(d)); } catch (e) { results.push({ businessKey: d.businessKey, name: d.name, location: "", website: d.websiteUrl, researchClass: d.classification, researchScore: d.platform?.score ?? 0, recommendedPackage: null, operational: null, mobileFriendly: null, identity: "not_testable", claims: [], evidenceUrls: [], duplicateOf: null, category: "C", confidence: "low", explanation: `Audit error: ${(e as Error).message.slice(0, 120)} (insufficient evidence)` }); } } }));
await browser.close();
results.sort((a, b) => a.businessKey.localeCompare(b.businessKey));

// ── metrics ──
const n = results.length;
const count = (k: Audit["category"]) => results.filter((r) => r.category === k).length;
const allMat = results.flatMap((r) => r.claims.filter((c) => c.material));
const tested = allMat.filter((c) => c.verdict !== "not_testable");
const supported = tested.filter((c) => c.verdict === "supported").length;
const byClass = (cls: string) => { const rs = results.filter((r) => r.researchClass === cls); return { n: rs.length, A: rs.filter((r) => r.category === "A").length, B: rs.filter((r) => r.category === "B").length, C: rs.filter((r) => r.category === "C").length, D: rs.filter((r) => r.category === "D").length }; };
const claimStats: Record<string, { supported: number; not_supported: number; not_testable: number }> = {};
for (const r of results) for (const c of r.claims.filter((x) => x.material)) { const s = claimStats[c.code] ??= { supported: 0, not_supported: 0, not_testable: 0 }; s[c.verdict]++; }
const pct = (x: number, d = n) => (d ? Math.round((x / d) * 1000) / 10 : null);
const summary = {
  kind: "Independent automated re-verification (fresh fetch + real Chromium desktop/mobile render) of the leads promoted by research-live-sample run 41145776120",
  leadsAudited: n, expected: 159,
  categories: { A: count("A"), B: count("B"), C: count("C"), D: count("D") },
  percentages: { A: pct(count("A")), B: pct(count("B")), C: pct(count("C")), D: pct(count("D")), AorB: pct(count("A") + count("B")) },
  byResearchClass: { VERIFIED_WEBSITE_BROKEN: byClass("VERIFIED_WEBSITE_BROKEN"), VERIFIED_WEBSITE_ISSUES: byClass("VERIFIED_WEBSITE_ISSUES"), NO_OFFICIAL_WEBSITE_FOUND: byClass("NO_OFFICIAL_WEBSITE_FOUND") },
  materialClaims: { total: allMat.length, tested: tested.length, supported, refuted: tested.length - supported, notTestable: allMat.length - tested.length, supportedPctOfTested: pct(supported, tested.length) },
  claimStats,
  identity: Object.fromEntries(["confirmed", "weak", "contradicted", "no_website", "not_testable"].map((k) => [k, results.filter((r) => r.identity === k).length])),
  incorrectWebsiteMatches: results.filter((r) => r.identity === "contradicted" && r.website).length,
  falseNoWebsiteClaims: results.filter((r) => !r.website && r.category === "D").length,
  duplicates: results.filter((r) => r.duplicateOf).length,
  operational: { yes: results.filter((r) => r.operational === true).length, no: results.filter((r) => r.operational === false).length, unknown: results.filter((r) => r.operational === null && r.website).length },
  mobileFriendly: { yes: results.filter((r) => r.mobileFriendly === true).length, no: results.filter((r) => r.mobileFriendly === false).length },
  falsePositiveRatePct: pct(count("D")),
  gate: {
    aOrBAtLeast80Pct: (pct(count("A") + count("B")) ?? 0) >= 80,
    materialClaimsSupportedAtLeast90PctOfTested: (pct(supported, tested.length) ?? 0) >= 90,
    zeroDuplicatesPromoted: results.filter((r) => r.duplicateOf).length === 0,
  },
  commercialFit: "not machine-assessable (budget, intent and decision-maker are never inferred)",
  elapsedMs: Date.now() - started, httpRequests: http.requests, resources: { before: r0, after: await snapshot(process.cwd()) },
};
writeFileSync(join(OUT, "audit-summary.json"), JSON.stringify(summary, null, 2));
writeFileSync(join(OUT, "audit.json"), JSON.stringify(results, null, 2));
const esc = (s: unknown) => String(s ?? "").replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 220);
writeFileSync(join(OUT, "audit-report.md"), [
  "# Independent audit of promoted research leads (PRIVATE)", "",
  `Run 41145776120, ${n} leads. Method and rubric: docs/research/AUDIT.md. Commercial fit is not assessed by machine.`, "",
  `A ${summary.categories.A} · B ${summary.categories.B} · C ${summary.categories.C} · D ${summary.categories.D}. Material claims supported: ${supported}/${tested.length} tested (${allMat.length - tested.length} not testable).`, "",
  "| # | Cat | Conf | Business | Location | Website | Research class / score | Identity | Operational | Mobile-friendly | Claims (verdict) | Package | Why |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ...results.map((r, i) => `| ${i + 1} | ${r.category} | ${r.confidence} | ${esc(r.name)} | ${esc(r.location)} | ${esc(r.website ?? "none found")} | ${esc(r.researchClass)} / ${r.researchScore} | ${r.identity} | ${r.operational ?? "?"} | ${r.mobileFriendly ?? "?"} | ${esc(r.claims.filter((c) => c.material).map((c) => `${c.code}: ${c.verdict}`).join("; "))} | ${r.category <= "B" ? esc(r.recommendedPackage) : ""} | ${esc(r.explanation)} |`),
].join("\n"));
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
