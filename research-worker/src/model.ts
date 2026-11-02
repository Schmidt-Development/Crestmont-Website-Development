// Local model (Ollama on this machine only) for wording, never for decisions. Input is the structured evidence;
// output is a short factual summary and a call-prep brief. Qualification, scores and packages are computed in code
// (src/domain/research.ts). A draft that adds facts (prices, percentages, guarantees, unseen domains) is discarded.
import { assertLoopback } from "./config.ts";
import type { GpuAdmission } from "./gpu-admission.ts";
import { modelTextProblems, type Finding, type WebsiteClass, WEBSITE_CLASS_LABELS } from "../../src/domain/research.ts";

export interface DraftInput { name: string; category: string | null; city: string | null; state: string | null; websiteClass: WebsiteClass; websiteUrl: string | null; findings: Finding[]; recommendedPackage: string | null; allowedDomains: string[] }
/**
 * `deferred` means the GPU was not available and Ollama was never called, so the prospect keeps its evidence-only
 * wording and the draft is worth retrying. It is not a failure.
 */
export interface Draft { summary: string | null; brief: string | null; model: string; rejected: string[]; deferred?: boolean; deferredReason?: string }

const SYSTEM = `You write short, factual notes for a website-design company's sales team.
Use ONLY the facts in the JSON you are given. Do not add facts, numbers, prices, percentages, promises or guesses.
Never claim results (more sales, rankings, traffic). Never insult the business or its website. If there are no
findings, say only what the website check found. Write plain English, no markdown.
Return JSON: {"summary": "<= 60 words: who the business is and what was observed about its website",
"brief": "<= 90 words: how a person could open a respectful call, referring only to the observed findings"}`;

export class LocalModel {
  readonly baseUrl: string;
  readonly name: string;
  readonly timeoutMs: number;
  readonly numCtx: number;
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  readonly concurrency: number;
  /** How long Ollama holds the model after a draft. Kept short so research never squats the shared GPU. */
  readonly keepAlive: string;
  /** Cooperative admission against other GPU users on this machine (the AI Website Builder above all). */
  readonly admission: GpuAdmission | null;
  calls = 0;
  failures = 0;
  deferred = 0;
  constructor(o: { baseUrl: string; name: string; timeoutMs: number; numCtx: number; concurrency: number; keepAlive?: string; admission?: GpuAdmission | null }) {
    assertLoopback(o.baseUrl);
    this.baseUrl = o.baseUrl; this.name = o.name; this.timeoutMs = o.timeoutMs; this.numCtx = o.numCtx; this.concurrency = o.concurrency;
    this.keepAlive = o.keepAlive ?? "30s";
    this.admission = o.admission ?? null;
  }

  /** Confirms Ollama answers and the configured model is pulled. */
  async preflight(fetchImpl: typeof fetch = fetch): Promise<string | null> {
    try {
      const r = await fetchImpl(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      const j = await r.json() as { models?: { name: string }[] };
      const names = (j.models ?? []).map((m) => m.name);
      return names.some((n) => n === this.name || n === `${this.name}:latest`) ? null : `model ${this.name} is not pulled (have: ${names.slice(0, 8).join(", ") || "none"}); run: ollama pull ${this.name}`;
    } catch (e) { return `Ollama not reachable at ${this.baseUrl}: ${(e as Error).message}`; }
  }

  async draft(input: DraftInput, fetchImpl: typeof fetch = fetch): Promise<Draft> {
    // Asked before the semaphore: a refused draft must not hold a drafting slot either.
    if (this.admission) {
      const a = await this.admission.check();
      if (!a.allowed) { this.deferred++; return { summary: null, brief: null, model: this.name, rejected: [], deferred: true, deferredReason: a.reason }; }
    }
    while (this.active >= this.concurrency) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try {
      this.calls++;
      const facts = { business: input.name, category: input.category, location: [input.city, input.state].filter(Boolean).join(", "), website: input.websiteUrl,
        websiteCheck: WEBSITE_CLASS_LABELS[input.websiteClass], findings: input.findings.slice(0, 10).map((f) => ({ title: f.title, severity: f.severity, evidence: f.evidence })), suggestedPackage: input.recommendedPackage };
      const res = await fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({ model: this.name, stream: false, keep_alive: this.admission?.keepAlive ?? this.keepAlive, format: { type: "object", properties: { summary: { type: "string" }, brief: { type: "string" } }, required: ["summary", "brief"] },
          options: { temperature: 0.2, num_ctx: this.numCtx, num_predict: 400 }, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: JSON.stringify(facts) }] }),
      });
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
      const j = await res.json() as { message?: { content?: string } };
      const out = JSON.parse(j.message?.content ?? "{}") as { summary?: unknown; brief?: unknown };
      const rejected: string[] = [];
      const accept = (s: unknown, max: number): string | null => {
        if (typeof s !== "string" || !s.trim()) return null;
        const t = s.trim().replace(/\s+/g, " ").slice(0, max);
        const p = modelTextProblems(t, input.allowedDomains);
        if (p.length) { rejected.push(...p); return null; }
        return t;
      };
      return { summary: accept(out.summary, 600), brief: accept(out.brief, 900), model: this.name, rejected };
    } catch (e) {
      this.failures++;
      return { summary: null, brief: null, model: this.name, rejected: [`model call failed: ${(e as Error).message.slice(0, 120)}`] };
    } finally { this.active--; this.waiters.shift()?.(); }
  }
}
