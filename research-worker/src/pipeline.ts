// One candidate through website discovery and verification (stages A–E) and the audit.
//  A  website fields in the source record (+ businesses already indexed with the same domain)
//  B  independent evidence: other open-data records with the same phone and a matching name; non-free-mail email
//     domains; Common Crawl captures of each candidate domain (cached, throttled)
//  C  direct, robots-respecting HTTP checks of each candidate (and a browser render when available)
//  D  identity comparison of the page with the record (phone, street address, city, name, listing sources)
//  E  classification with evidence, confidence, source and timestamps
// Never guesses a domain from the business name. "No official website found" is reported only after A, B and C ran
// and says so in its checks; it is not a claim that no website exists.
import { isCandidateOfficialDomain, isFreeMailDomain, normDomain, type Finding, type ProspectInput, type WebsiteCheck, type WebsiteClass } from "../../src/domain/research.ts";
import type { Candidate } from "./sources/types.ts";
import type { Http, FetchResult } from "./http.ts";
import type { State } from "./state.ts";
import type { CommonCrawl, CcEvidence } from "./sources/commoncrawl.ts";
import type { Browser } from "./browser.ts";
import { runLighthouse } from "./browser.ts";
import { pageFacts, identity, parkedPage, nameOverlap } from "./identity.ts";
import { brokenReason, accessRestricted, htmlFindings, brokenInternalLinks, browserFindings, lighthouseFindings } from "./audit.ts";

export interface Probe { domain: string; url: string; failures: { at: string; code: string; title: string; evidence: string }[] }
export interface Deps { http: Http; state: State; cc: CommonCrawl | null; browser: Browser | null; lighthousePath: string | null; brokenAttempts: number; brokenRecheckAfterMs: number; checkLinks: boolean }
export type Outcome =
  | { kind: "done"; cls: WebsiteClass; prospect: ProspectInput; send: boolean }
  | { kind: "defer"; until: Date; probe: Probe; note: string };

interface CandidateDomain { domain: string; listedBy: string[]; via: string }

const iso = () => new Date().toISOString();
/** Classes that can be a website-development opportunity; the rest are counted locally and not sent. */
export const SEND_CLASSES: WebsiteClass[] = ["VERIFIED_WEBSITE_BROKEN", "VERIFIED_WEBSITE_ISSUES", "NO_OFFICIAL_WEBSITE_FOUND"];

/** Stage A + B candidate domains, with who lists each. */
export function candidateDomains(c: Candidate, state: State): { domains: CandidateDomain[]; checks: WebsiteCheck[] } {
  const checks: WebsiteCheck[] = [];
  const out = new Map<string, CandidateDomain>();
  const add = (d: string | null, by: string | null, via: string) => {
    if (!d || !isCandidateOfficialDomain(d)) return;
    const e = out.get(d) ?? out.set(d, { domain: d, listedBy: [], via }).get(d)!;
    if (by && !e.listedBy.includes(by)) e.listedBy.push(by);
  };
  const own = c.sources[0]?.source ?? "source";
  const raw = c.websites.map(normDomain).filter((d): d is string => !!d);
  const social = raw.filter((d) => !isCandidateOfficialDomain(d));
  for (const d of raw) add(d, own, "source website field");
  checks.push({ stage: "A", method: `${own} website field`, result: raw.length ? `${raw.length} value(s): ${raw.slice(0, 4).join(", ")}${social.length ? ` (${social.length} social/directory profile(s) not counted as official)` : ""}` : "no website in the source record", at: iso() });
  // B: other open-data records that share this phone AND name (different source ids for the same business).
  const others = c.phones.flatMap((p) => state.businessesForPhone(p)).filter((k) => k !== c.businessKey);
  let corroborating = 0;
  for (const k of [...new Set(others)].slice(0, 10)) {
    const o = state.candidate(k);
    if (!o || nameOverlap(c.name, o.name) < 0.6) continue;
    corroborating++;
    for (const w of o.websites) add(normDomain(w), o.sources[0]?.source ?? "other source", "matching record in another dataset");
  }
  const emailDomains = c.emails.map((e) => e.split("@")[1]).filter((d) => d && !isFreeMailDomain(d));
  for (const d of emailDomains) add(d, null, "business email domain");
  checks.push({ stage: "B", method: "cross-source records (same phone and name) and business email domains", result: `${corroborating} matching record(s) in other datasets; ${emailDomains.length} business email domain(s)`, at: iso() });
  return { domains: [...out.values()].slice(0, 4), checks };
}

async function audit(deps: Deps, home: FetchResult, html: string): Promise<Finding[]> {
  const facts = pageFacts(html);
  const findings = htmlFindings(home, facts, html);
  if (deps.checkLinks) findings.push(...await brokenInternalLinks(deps.http, home, html));
  if (deps.browser) {
    const b = await deps.browser.check(home.finalUrl);
    findings.push(...browserFindings(home.finalUrl, b));
  }
  if (deps.lighthousePath) {
    const lh = await runLighthouse(deps.lighthousePath, home.finalUrl);
    if (lh) findings.push(...lighthouseFindings(home.finalUrl, lh));
  }
  return findings;
}

/** Identity confidence for the business record itself (exists, is this business), independent of any website. */
export function recordConfidence(c: Candidate): number {
  let s = c.sourceConfidence ?? 0.6;
  if (c.phones.length) s += 0.1;
  if (c.address.line && c.address.city) s += 0.1;
  if (c.operatingStatus === "permanently_closed") s = 0;
  return Math.max(0, Math.min(1, Math.round(s * 100) / 100));
}

export async function evaluate(c: Candidate, deps: Deps, probe: Probe | null): Promise<Outcome> {
  const { domains, checks } = candidateDomains(c, deps.state);
  let cc = new Map<string, CcEvidence>();
  if (deps.cc && domains.length) {
    cc = await deps.cc.lookup(domains.map((d) => d.domain));
    for (const d of domains) {
      const e = cc.get(d.domain);
      if (e) checks.push({ stage: "B", method: `Common Crawl columnar index ${e.crawl}`, result: e.captures ? `${d.domain}: ${e.captures} capture(s), last status ${e.lastStatus ?? "?"} at ${e.lastFetch ?? "?"}` : `${d.domain}: not captured`, at: iso() });
    }
  }
  const base = {
    businessKey: c.businessKey, name: c.name, category: c.category, address: c.address, lat: c.lat, lon: c.lon,
    phones: c.phones, emails: c.emails, domains: domains.map((d) => d.domain), sources: c.sources, lastVerifiedAt: iso(),
  };
  const recConf = recordConfidence(c);
  const done = (cls: WebsiteClass, website: Omit<ProspectInput["website"], "classification" | "checkedAt" | "checks">, findings: Finding[], identityConfidence: number): Outcome => {
    const prospect: ProspectInput = { ...base, website: { classification: cls, checkedAt: iso(), checks, ...website }, findings, identityConfidence };
    return { kind: "done", cls, prospect, send: SEND_CLASSES.includes(cls) && c.phones.length > 0 };
  };
  if (recConf < 0.5) return done("BUSINESS_IDENTITY_UNCERTAIN", { url: null, confidence: recConf, identitySignals: [`record confidence ${recConf}`] }, [], recConf);

  let restricted = false, loadedUnconfirmed = false;
  const unconfirmedReasons: string[] = [];
  for (const d of domains) {
    let home = await deps.http.get(`https://${d.domain}/`);
    if (home.error?.kind === "tls" || (home.error && home.error.kind !== "dns" && home.error.kind !== "blocked_address")) {
      const plain = await deps.http.get(`http://${d.domain}/`);
      if (!plain.error && plain.status !== null && plain.status < 400) home = plain; // reachable without TLS: audited below (no_https finding)
    }
    deps.state.bump("websites_checked", new Date());
    checks.push({ stage: "C", method: `HTTP GET https://${d.domain}/ (robots.txt honoured)`, result: home.robotsBlocked ? "not fetched: robots.txt disallows" : home.error ? `${home.error.kind}: ${home.error.message.slice(0, 120)}` : `HTTP ${home.status} at ${home.finalUrl} in ${home.ms} ms`, at: iso() });
    if (home.error?.kind === "blocked_address") { unconfirmedReasons.push(`${d.domain} points at a non-public address`); continue; }
    if (accessRestricted(home)) { restricted = true; continue; }
    const broken = brokenReason(home);
    if (broken) {
      if (!d.listedBy.length) { unconfirmedReasons.push(`${d.domain} (from ${d.via}) does not load`); continue; }
      // Broken needs repeated, spaced failures: one bad moment is not a broken website.
      const prior = probe && probe.domain === d.domain ? probe.failures : [];
      const failures = [...prior, { at: iso(), code: broken.code, title: broken.title, evidence: broken.evidence }];
      if (failures.length < deps.brokenAttempts) {
        return { kind: "defer", until: new Date(Date.now() + deps.brokenRecheckAfterMs), probe: { domain: d.domain, url: home.url, failures }, note: `${broken.title}; re-checking later` };
      }
      const e = cc.get(d.domain);
      const conf = Math.min(0.95, 0.7 + 0.1 * (d.listedBy.length - 1) + (e && e.captures > 0 ? 0.1 : 0));
      checks.push({ stage: "D", method: "identity by listing", result: `listed as this business's website by ${d.listedBy.join(", ")}${e?.captures ? `; captured ${e.captures}× by Common Crawl` : ""}`, at: iso() });
      const finding: Finding = { code: broken.code, title: broken.title, severity: "critical", confidence: 0.9, url: home.url, method: `HTTP GET (no JS), ${failures.length} attempts`, observedAt: failures.at(-1)!.at,
        evidence: failures.map((x) => `${x.at}: ${x.evidence}`).join(" | ").slice(0, 500), reproduction: `Open ${home.url}` };
      return done("VERIFIED_WEBSITE_BROKEN", { url: home.url, confidence: conf, identitySignals: [`listed by ${d.listedBy.join(", ")}`] }, [finding], Math.max(recConf, conf));
    }
    if (home.status === null || home.status >= 400) { unconfirmedReasons.push(`${d.domain}: HTTP ${home.status}`); continue; }
    const facts = pageFacts(home.body);
    const parked = parkedPage(facts);
    if (parked) {
      if (!d.listedBy.length) { unconfirmedReasons.push(`${d.domain} is a parked/placeholder page`); continue; }
      const finding: Finding = { code: "listed_domain_parked", title: "The listed website shows a parked or placeholder page", severity: "critical", confidence: 0.85, url: home.finalUrl, method: "HTTP GET (no JS)", observedAt: iso(), evidence: `Page text includes "${parked}"`, reproduction: `Open ${home.finalUrl}` };
      checks.push({ stage: "D", method: "identity by listing", result: `listed by ${d.listedBy.join(", ")}; page is a placeholder`, at: iso() });
      return done("VERIFIED_WEBSITE_BROKEN", { url: home.finalUrl, confidence: 0.75, identitySignals: [`listed by ${d.listedBy.join(", ")}`, "placeholder page"] }, [finding], recConf);
    }
    const id = identity(c, facts, d.listedBy);
    checks.push({ stage: "D", method: "page vs record (phone, street, city, name, listings)", result: `${id.official ? "official" : "not confirmed"} (score ${id.score}): ${[...id.signals, ...id.contradictions].join("; ") || "no matching signals"}`, at: iso() });
    if (!id.official) { loadedUnconfirmed = true; unconfirmedReasons.push(`${d.domain} loads but does not match this business`); continue; }
    deps.state.indexDomain(d.domain, c.businessKey, c.sources[0]?.source ?? "source");
    const findings = await audit(deps, home, home.body);
    const material = findings.some((f) => f.confidence >= 0.6 && (f.severity === "medium" || f.severity === "high" || f.severity === "critical"));
    const renderBroken = findings.some((f) => f.code === "render_blank" || f.code === "empty_page");
    checks.push({ stage: "E", method: "audit", result: `${findings.length} finding(s)`, at: iso() });
    return done(renderBroken ? "VERIFIED_WEBSITE_BROKEN" : material ? "VERIFIED_WEBSITE_ISSUES" : "VERIFIED_OFFICIAL_WEBSITE",
      { url: home.finalUrl, confidence: id.score, identitySignals: id.signals }, findings, Math.max(recConf, id.score));
  }
  if (restricted) return done("WEBSITE_UNVERIFIED", { url: null, confidence: 0.3, identitySignals: ["site restricts automated access (robots.txt or HTTP 401/403/429); not tested"] }, [], recConf);
  if (loadedUnconfirmed || domains.some((d) => d.listedBy.length)) return done("WEBSITE_UNVERIFIED", { url: null, confidence: 0.4, identitySignals: unconfirmedReasons }, [], recConf);
  if (!c.phones.length && !(c.address.line && c.address.city)) return done("BUSINESS_IDENTITY_UNCERTAIN", { url: null, confidence: recConf, identitySignals: ["no phone or street address to confirm the business"] }, [], recConf);
  checks.push({ stage: "E", method: "conclusion", result: `no official website found by stages A-C${unconfirmedReasons.length ? ` (${unconfirmedReasons.join("; ")})` : ""}; this is not proof that none exists`, at: iso() });
  return done("NO_OFFICIAL_WEBSITE_FOUND", { url: null, confidence: deps.cc ? 0.7 : 0.6, identitySignals: [`record confidence ${recConf}`] }, [], recConf);
}
