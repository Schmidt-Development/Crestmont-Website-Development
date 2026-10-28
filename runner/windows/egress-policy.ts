// Egress allow-list policy for the Windows deployment's Squid proxy (runner/windows/proxy/squid.conf.template).
//
//   renderSquidConf()   the same substitution Install-CrestmontRunner.ps1 performs (SquidConf.ps1,
//                       ConvertTo-SquidConf), with the same input validation, so the rendered file can be tested here
//                       and compared byte for byte with the PowerShell output where pwsh is available.
//   evaluateSquid()     a small evaluator for the subset of Squid's http_access semantics this config uses (src,
//                       port, method and dstdomain/dstdom_regex ACLs; first matching rule wins). It exists so tests can
//                       ask "may the install network reach api.openai.com?" instead of pattern-matching text. It is
//                       not Squid: `squid -k parse` (CI, runner-images job) is the authority on syntax.

import { readFileSync } from "node:fs";
import path from "node:path";
import { PAID_AI_DOMAINS, domainMatches, isPaidAiHost } from "../src/providers/paid-hosts.ts";

export const TEMPLATE_PATH = path.join(import.meta.dirname, "proxy", "squid.conf.template");
export const PLACEHOLDER_NONE = "none.invalid";
/** Hosts the Ollama-in-Docker profile needs for `ollama pull` (must match Install-CrestmontRunner.ps1). */
export const OLLAMA_PULL_DOMAINS = ["registry.ollama.ai", ".ollama.com", ".r2.cloudflarestorage.com"];
/** Founder V3: exact hosts Claude Code needs (inference + plan sign-in), allowed only from the claude worker network. */
export const CLAUDE_SERVICE_DOMAINS = ["api.anthropic.com", "claude.ai", "claude.com", "platform.claude.com", "console.anthropic.com"];

/** Hosted inference APIs that must never be reachable: one list, shared with the local provider. */
export { PAID_AI_DOMAINS, domainMatches, isPaidAiHost } from "../src/providers/paid-hosts.ts";

const DOMAIN = /^\.?(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export class EgressPolicyError extends Error {
  constructor(message: string) { super(message); this.name = "EgressPolicyError"; }
}

/** Validate one allow-list entry: a DNS name (optionally with a leading dot), never a paid AI host, never "all". */
export function validateDomain(d: string, label: string): string {
  const v = String(d ?? "").trim().toLowerCase();
  if (!DOMAIN.test(v)) throw new EgressPolicyError(`${label}: "${String(d).slice(0, 80)}" is not a valid host name (letters, digits, dots and hyphens only)`);
  if (isPaidAiHost(v.replace(/^\./, "")) || PAID_AI_DOMAINS.some((p) => domainMatches(v, p.replace(/^\./, "")))) {
    throw new EgressPolicyError(`${label}: ${v} is a hosted AI API (or covers one); it is always denied and cannot be allow-listed`);
  }
  return v;
}

export interface SquidInputs {
  /** Control-plane host (from -PlatformUrl). */
  platformHost: string;
  /** Extra hosts the runner may reach (repos, previews). */
  extraDomains?: string[];
  /** Ollama runs in Docker and pulls models through the proxy. */
  ollamaInDocker?: boolean;
  /** Founder V3: Claude Code builder workers (Claude hosts reachable from the claude worker network only). */
  claudeCode?: boolean;
}

export function renderSquidConf(template: string, i: SquidInputs): string {
  const platform = validateDomain(i.platformHost, "platform host");
  if (platform.startsWith(".")) throw new EgressPolicyError("platform host: give the exact host, not a .domain wildcard");
  const extras = (i.extraDomains ?? []).filter((d) => String(d ?? "").trim() !== "").map((d) => validateDomain(d, "extra egress domain"));
  const extra = extras.length ? extras.join(" ") : PLACEHOLDER_NONE;
  const pull = i.ollamaInDocker ? OLLAMA_PULL_DOMAINS.join(" ") : PLACEHOLDER_NONE;
  const claude = i.claudeCode ? CLAUDE_SERVICE_DOMAINS.join(" ") : PLACEHOLDER_NONE;
  for (const p of ["__PLATFORM_HOST__", "__RUNNER_EXTRA_DOMAINS__", "__OLLAMA_PULL_DOMAINS__", "__CLAUDE_SERVICE_DOMAINS__"]) {
    if (!template.includes(p)) throw new EgressPolicyError(`template is missing the ${p} placeholder`);
  }
  const out = template.replaceAll("__PLATFORM_HOST__", platform).replaceAll("__RUNNER_EXTRA_DOMAINS__", extra).replaceAll("__OLLAMA_PULL_DOMAINS__", pull).replaceAll("__CLAUDE_SERVICE_DOMAINS__", claude).replace(/\r\n/g, "\n");
  if (/__[A-Z_]+__/.test(out.replace(/^#.*$/gm, ""))) throw new EgressPolicyError("unreplaced placeholder in the rendered configuration");
  return out;
}

export function renderDefaultSquidConf(i: SquidInputs): string {
  return renderSquidConf(readFileSync(TEMPLATE_PATH, "utf8"), i);
}

// ── evaluator ──

interface Acl { type: string; values: string[] }
export interface SquidPolicy { acls: Map<string, Acl[]>; rules: { action: "allow" | "deny"; terms: { name: string; negate: boolean }[] }[] }

export function parseSquidPolicy(conf: string): SquidPolicy {
  const acls = new Map<string, Acl[]>();
  const rules: SquidPolicy["rules"] = [];
  for (const raw of conf.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === "acl") {
      const [, name, type, ...values] = parts;
      const list = acls.get(name) ?? [];
      list.push({ type, values: values.filter((v) => v !== "-i") });
      acls.set(name, list);
    } else if (parts[0] === "http_access") {
      rules.push({ action: parts[1] as "allow" | "deny", terms: parts.slice(2).map((t) => ({ name: t.replace(/^!/, ""), negate: t.startsWith("!") })) });
    }
  }
  return { acls, rules };
}

export interface SquidRequest { clientIp: string; method: string; host: string; port: number }

function ipInCidr(ip: string, cidr: string): boolean {
  const [base, bitsS] = cidr.split("/");
  const bits = bitsS === undefined ? 32 : Number(bitsS);
  const toInt = (a: string) => a.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
}

function aclMatches(p: SquidPolicy, name: string, r: SquidRequest): boolean {
  if (name === "all") return true;
  const defs = p.acls.get(name);
  if (!defs) throw new EgressPolicyError(`http_access uses undefined acl ${name}`);
  return defs.some((a) => {
    switch (a.type) {
      case "src": return a.values.some((c) => ipInCidr(r.clientIp, c));
      case "port": return a.values.some((v) => Number(v) === r.port);
      case "method": return a.values.some((v) => v.toUpperCase() === r.method.toUpperCase());
      case "dstdomain": return a.values.some((v) => domainMatches(v, r.host));
      case "dstdom_regex": return a.values.some((v) => new RegExp(v, "i").test(r.host));
      default: throw new EgressPolicyError(`acl type ${a.type} is not modelled by this evaluator`);
    }
  });
}

/** First matching http_access rule decides (no rule matching = the opposite of the last rule, as in Squid). */
export function evaluateSquid(p: SquidPolicy, r: SquidRequest): { allowed: boolean; rule: string } {
  for (const rule of p.rules) {
    if (rule.terms.every((t) => aclMatches(p, t.name, r) !== t.negate)) {
      return { allowed: rule.action === "allow", rule: `http_access ${rule.action} ${rule.terms.map((t) => (t.negate ? "!" : "") + t.name).join(" ")}` };
    }
  }
  const last = p.rules.at(-1);
  return { allowed: last ? last.action === "deny" : false, rule: "(implicit)" };
}

/** Client addresses of the compose networks (docker-compose.yml ipam subnets). */
export const NETWORKS = { runner: "172.30.10.5", install: "172.30.20.5", claude: "172.30.30.5", outside: "10.9.8.7" } as const;
