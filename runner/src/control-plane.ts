// Control-plane client for docs/ai-builds/RUNNER-PROTOCOL.md (v1).
//  - Every request: POST, JSON body, header x-crestmont-runner-signature: t=<unix s>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
//  - 409 {"error":"lease_lost"} -> LeaseLostError (caller stops work on that job immediately, keeps the workspace).
//  - Network errors, 5xx and 429 are retried with exponential backoff + jitter; other 4xx are never retried.

import { createHmac } from "node:crypto";
import type {
  ClaimResponse, HeartbeatRequest, HeartbeatResponse, CheckpointRequest, RequirementItem, CompleteRequest, Job,
  AiDraftJob, AiDraftClaimResponse, AiDraftCompleteRequest, DiagnosticCheckpoint, ExpiredPreview, ExpiredPreviewsResponse,
  SiteDeployment, DeploymentClaimResponse, DeploymentCompleteRequest, CycleSubmitResponse, WorkerStatus, ApprovedArtifact, FrontendImportClaim,
  FrontendImportReportResult, ContractSubmitResult, AssetResolveResult } from "./protocol.ts";
import { RUNNER_VERSION, LIMITS } from "./protocol.ts";
import type { Logger } from "./log.ts";
import { silentLogger, errorMessage } from "./log.ts";

export const SIGNATURE_HEADER = "x-crestmont-runner-signature";

export function signBody(secret: string, body: string, unixSeconds: number): string {
  const mac = createHmac("sha256", secret).update(`${unixSeconds}.${body}`).digest("hex");
  return `t=${unixSeconds},v1=${mac}`;
}

/** Verifier used by the fake control plane in tests (same rules as the Worker: ±600 s tolerance). */
export function verifySignature(secret: string, body: string, header: string | undefined, nowSeconds: number, toleranceSeconds = 600): boolean {
  if (!header) return false;
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return timingSafeEqualHex(expected, m[2]);
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class LeaseLostError extends Error {
  constructor(jobId: string) {
    super(`lease_lost for job ${jobId}`);
    this.name = "LeaseLostError";
  }
}

export class ControlPlaneError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, path: string) {
    super(`control plane ${path} answered ${status}: ${body.slice(0, 300)}`);
    this.name = "ControlPlaneError";
    this.status = status;
    this.body = body;
  }
}

export interface RetryPolicy { attempts: number; baseMs: number; maxMs: number }

export interface ControlPlaneOptions {
  /** V2 worker mode: the builder worker this runner process serves (id + Crestmont enrollment key). */
  worker?: { id: string; key: string } | null;
  baseUrl: string;
  secret: string;
  runnerId: string;
  fetchImpl?: typeof fetch;
  retry?: Partial<RetryPolicy>;
  timeoutMs?: number;
  logger?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ControlPlaneClient {
  readonly opts: ControlPlaneOptions;
  readonly retry: RetryPolicy;
  private readonly log: Logger;
  constructor(opts: ControlPlaneOptions) {
    if (!/^https?:\/\//.test(opts.baseUrl)) throw new Error("CONTROL_PLANE_URL must be an http(s) URL");
    if (!opts.secret) throw new Error("BUILD_RUNNER_SECRET is required");
    this.opts = opts;
    this.retry = { attempts: 5, baseMs: 500, maxMs: 30_000, ...(opts.retry ?? {}) };
    this.log = opts.logger ?? silentLogger;
  }

  /** Low-level signed POST with retry. Returns the parsed JSON body of a 2xx answer. */
  async post<T>(path: string, payload: unknown, ctx: { jobId?: string } = {}): Promise<T> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const sleep = this.opts.sleep ?? defaultSleep;
    const url = this.opts.baseUrl.replace(/\/+$/, "") + path;
    const withNonce = () => {
      // A fresh random nonce in every signed request lets the control plane refuse replays of a captured request
      // (CREST-GAP-087). Each attempt gets its own nonce, so a retry after a lost response behaves as before.
      const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
      return JSON.stringify(payload && typeof payload === "object" && !Array.isArray(payload) ? { ...(payload as Record<string, unknown>), _nonce: nonce } : payload);
    };
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
      const t = Math.floor((this.opts.now ?? Date.now)() / 1000);
      const body = withNonce();
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signBody(this.opts.secret, body, t) },
          body,
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
        });
      } catch (err) {
        lastErr = err;
        this.log.warn("control plane network error", { path, attempt, error: errorMessage(err) });
        if (attempt < this.retry.attempts) await sleep(this.backoff(attempt));
        continue;
      }
      const text = await res.text();
      if (res.ok) {
        try { return JSON.parse(text) as T; } catch { throw new ControlPlaneError(res.status, "invalid JSON", path); }
      }
      if (res.status === 409 && /lease_lost/.test(text)) throw new LeaseLostError(ctx.jobId ?? "?");
      const retryable = res.status === 429 || res.status >= 500;
      lastErr = new ControlPlaneError(res.status, text, path);
      if (!retryable) throw lastErr;
      this.log.warn("control plane retryable status", { path, attempt, status: res.status });
      if (attempt < this.retry.attempts) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, this.retry.maxMs) : this.backoff(attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  backoff(attempt: number): number {
    const exp = Math.min(this.retry.maxMs, this.retry.baseMs * 2 ** (attempt - 1));
    return Math.round(exp / 2 + Math.random() * (exp / 2));
  }

  claim(capabilities: string[]): Promise<ClaimResponse> {
    return this.post<ClaimResponse>("/api/builds/runner/claim", {
      runnerId: this.opts.runnerId.slice(0, LIMITS.runnerId), version: RUNNER_VERSION, capabilities,
      ...(this.opts.worker ? { workerId: this.opts.worker.id, workerKey: this.opts.worker.key, workerStatus: this.workerStatus } : {}),
    });
  }

  /** V2 worker mode: latest status reported with every claim (usage only from an authorized interface). */
  workerStatus: WorkerStatus = {};

  async reportWorkerStatus(status: WorkerStatus): Promise<void> {
    this.workerStatus = status;
    if (!this.opts.worker) return;
    await this.post("/api/builds/runner/workers/status", { runnerId: this.opts.runnerId.slice(0, LIMITS.runnerId), workerId: this.opts.worker.id, workerKey: this.opts.worker.key, status });
  }

  /** V2: store the Architect's specification. null = this platform has no V2 endpoints. */
  async storeSpec(job: Pick<Job, "id" | "leaseToken">, spec: unknown, provider: string): Promise<{ specVersion: number } | null> {
    try { return await this.post("/api/builds/runner/pipeline/spec", { jobId: job.id, leaseToken: job.leaseToken, spec, provider }); }
    catch (err) { if (err instanceof ControlPlaneError && (err.status === 404 || err.status === 405)) return null; throw err; }
  }

  /** V2: one completed implementation cycle with the reviewer's proposal; the platform returns the authoritative decision. */
  async submitCycle(job: Pick<Job, "id" | "leaseToken">, body: Record<string, unknown>): Promise<CycleSubmitResponse | null> {
    try { return await this.post<CycleSubmitResponse>("/api/builds/runner/cycles/submit", { jobId: job.id, leaseToken: job.leaseToken, ...body }); }
    catch (err) { if (err instanceof ControlPlaneError && (err.status === 404 || err.status === 405)) return null; throw err; }
  }

  /**
   * V5: the bytes of one Design Gallery image this job was given. null = no such image (an older platform, a
   * reference the owner has since disabled, or an object that is simply not there). The caller must treat null as
   * "this reference was never seen" and report it, never as a reason to claim the gallery was used.
   */
  async galleryImage(job: Pick<Job, "id" | "leaseToken">, referenceId: string, variant: "desktop" | "tablet" | "mobile"): Promise<{ base64: string; contentType: string; size: number } | null> {
    try { return await this.post("/api/builds/runner/gallery/image", { jobId: job.id, leaseToken: job.leaseToken, referenceId, variant }); }
    catch (err) { if (err instanceof ControlPlaneError && (err.status === 404 || err.status === 405)) return null; throw err; }
  }

  /** V5: which gallery images a vision model actually received. The platform keeps it as evidence. */
  async galleryImagesSeen(job: Pick<Job, "id" | "leaseToken">, referenceIds: string[], model: string): Promise<void> {
    try { await this.post("/api/builds/runner/gallery/seen", { jobId: job.id, leaseToken: job.leaseToken, referenceIds, model }); }
    catch (err) { if (!(err instanceof ControlPlaneError && (err.status === 404 || err.status === 405))) throw err; }
  }

  /**
   * The approved frontend for this job (protocol v1.7).
   *
   * No artifact, project or version is named: the platform resolves it from this job's own project and from the
   * baseline a person approved, so there is nothing here for a runner to get wrong or be tricked into sending.
   * The caller verifies the sha256 over the bytes before opening the archive.
   */
  async approvedArtifact(job: Pick<Job, "id" | "leaseToken">): Promise<ApprovedArtifact | null> {
    try { return await this.post("/api/builds/runner/frontend/artifact", { jobId: job.id, leaseToken: job.leaseToken }); }
    catch (err) {
      // 404/405: a platform that predates this endpoint. 409: no approved baseline for this project. Both mean
      // "there is no design-locked work here", and the job falls through to the path it would otherwise take.
      if (err instanceof ControlPlaneError && [404, 405, 409].includes(err.status)) return null;
      throw err;
    }
  }


  // ── the import step ────────────────────────────────────────────────────────────────────────────────────────
  //
  // Not a build. An artifact that has been uploaded and scanned has to be unpacked, built and measured before
  // anyone can approve its design, and until now nothing asked for that work: both calls above serve a leased
  // BUILD and require a baseline that is already approved. These three are this runner's half of the channel.
  //
  // Each treats a platform that predates them as "there is no such work", so an older control plane simply never
  // offers an import and this runner behaves exactly as it did before.

  /**
   * One artifact waiting to be imported, or null when there is none.
   *
   * A 404/405 is NOT flattened to null here: "this platform has no import channel" and "there is nothing to
   * import" are different answers, and only the caller can act on the difference -- it stops asking. Flattening
   * them would leave the worker polling an older control plane for ever and its `unsupported` branch unreachable.
   */
  async claimFrontendImport(runnerId: string): Promise<FrontendImportClaim | null> {
    const r = await this.post<{ artifact: FrontendImportClaim | null }>("/api/builds/runner/frontend/import/claim", { runnerId });
    return r?.artifact ?? null;
  }

  /** The archive for a claimed artifact. The caller verifies the sha256 before opening it. */
  async frontendImportBytes(artifactId: string): Promise<{ artifactId: string; sha256: string; filename: string; base64: string } | null> {
    try { return await this.post("/api/builds/runner/frontend/import/bytes", { artifactId }); }
    catch (err) {
      // 409: it stopped being importable while we held it (flagged, superseded, released). That is the platform's
      // decision, and the right answer is to stop rather than to retry.
      if (err instanceof ControlPlaneError && [404, 405, 409].includes(err.status)) return null;
      throw err;
    }
  }

  /** What the import found. A measured design is a DRAFT baseline: nothing here ever approves one. */
  async reportFrontendImport(r: {
    artifactId: string;
    status: "imported" | "rejected";
    framework?: string | null;
    archiveRoot?: string | null;
    lockfileSha?: string | null;
    problems?: string[];
    baseline?: unknown;
    /**
     * What the measurement found, beside the baseline itself.
     *
     * The baseline is the design lock: signatures, screenshot hashes and the fingerprint over them. The platform
     * also records the route, interaction and state inventory the same measurement produced, and shows their
     * counts on the Artifact Builder screen. Sent as its own field because it is evidence about the artifact, not
     * part of what is frozen.
     */
    measurement?: unknown;
  }): Promise<FrontendImportReportResult | null> {
    try { return (await this.post<FrontendImportReportResult>("/api/builds/runner/frontend/import/report", { ...r })) ?? null; }
    catch (err) {
      if (err instanceof ControlPlaneError && [404, 405].includes(err.status)) return null;
      throw err;
    }
  }

  /**
   * Ask the platform to acquire the external assets this artifact depends on.
   *
   * Sent in batches by the caller. A 404/405 means this platform has no asset channel, which is an older
   * platform rather than a failure: the import then measures the artifact as it stands, and says so.
   */
  async resolveFrontendAssets(r: {
    artifactId: string;
    assets: { url: string; kind: string; referencedBy?: string | null }[];
  }): Promise<AssetResolveResult | null> {
    try { return (await this.post<AssetResolveResult>("/api/builds/runner/frontend/assets/resolve", { ...r })) ?? null; }
    catch (err) {
      if (err instanceof ControlPlaneError && [404, 405].includes(err.status)) return null;
      throw err;
    }
  }

  /**
   * A drafted integration contract, for the platform's validator to accept or refuse.
   *
   * The answer is the validator's, and a refusal arrives as `recorded: false` with its reasons rather than as an
   * HTTP error, because the reasons are the point: the draft is corrected against them and submitted again. A
   * 404/405 means this platform has no contract channel at all -- an older platform rather than a bad draft -- so
   * it comes back null and the caller stops trying instead of redrafting against nothing.
   */
  async submitFrontendContract(r: {
    projectId: string;
    manifest: unknown;
    attempt: number;
    attemptsAllowed: number;
    authorModel?: string | null;
  }): Promise<ContractSubmitResult | null> {
    try { return (await this.post<ContractSubmitResult>("/api/builds/runner/frontend/contract/submit", { ...r })) ?? null; }
    catch (err) {
      if (err instanceof ControlPlaneError && [404, 405].includes(err.status)) return null;
      throw err;
    }
  }

  /** The approved design this build is held to: manifests and screenshot digests, without the archive. */
  async approvedBaseline(job: Pick<Job, "id" | "leaseToken">): Promise<Record<string, unknown> | null> {
    try { return await this.post("/api/builds/runner/frontend/baseline", { jobId: job.id, leaseToken: job.leaseToken }); }
    catch (err) {
      if (err instanceof ControlPlaneError && [404, 405, 409].includes(err.status)) return null;
      throw err;
    }
  }

  async reportIntegrations(job: Pick<Job, "id" | "leaseToken">, items: unknown[]): Promise<void> {
    try { await this.post("/api/builds/runner/integrations/report", { jobId: job.id, leaseToken: job.leaseToken, items }); }
    catch (err) { if (!(err instanceof ControlPlaneError && (err.status === 404 || err.status === 405))) throw err; }
  }

  /** Decisions on this job's approval requests (null = a platform without the endpoint). */
  async listApprovals(job: Pick<Job, "id" | "leaseToken">): Promise<{ id: string; kind: string; summary: string; operation: string | null; status: string; decision_note: string | null }[] | null> {
    try { return (await this.post<{ approvals: { id: string; kind: string; summary: string; operation: string | null; status: string; decision_note: string | null }[] }>("/api/builds/runner/approvals/list", { jobId: job.id, leaseToken: job.leaseToken })).approvals; }
    catch (err) { if (err instanceof ControlPlaneError && (err.status === 404 || err.status === 405)) return null; throw err; }
  }

  async requestApproval(job: Pick<Job, "id" | "leaseToken">, req: { kind: string; summary: string; detail?: string; operation?: string }): Promise<{ id: string; status: string } | null> {
    try { return await this.post("/api/builds/runner/approvals/request", { runnerId: this.opts.runnerId.slice(0, LIMITS.runnerId), jobId: job.id, leaseToken: job.leaseToken, ...req }); }
    catch (err) { if (err instanceof ControlPlaneError && (err.status === 404 || err.status === 405)) return null; throw err; }
  }

  heartbeat(job: Pick<Job, "id" | "leaseToken">, req: HeartbeatRequest): Promise<HeartbeatResponse> {
    const activity = req.activity?.slice(-20).map((a) => ({ kind: a.kind, message: a.message.slice(0, LIMITS.activityMessage) }));
    return this.post<HeartbeatResponse>("/api/builds/runner/heartbeat", {
      jobId: job.id, leaseToken: job.leaseToken, stage: req.stage, runCostUsd: round4(req.runCostUsd), turns: req.turns,
      ...(req.sessionId ? { sessionId: req.sessionId } : {}), ...(activity && activity.length ? { activity } : {}),
      ...(req.provider ? { provider: req.provider.slice(0, 40) } : {}), ...(req.model ? { model: req.model.slice(0, 120) } : {}),
      ...(req.orchestration ? { orchestration: { activity: req.orchestration.activity.slice(0, 30), model: req.orchestration.model?.slice(0, 120) ?? null, task: req.orchestration.task?.slice(0, 40) ?? null } } : {}),
    }, { jobId: job.id });
  }

  /**
   * AI Build preview: store the rendered frontend of one revision so the Founder can see what this cycle produced.
   *
   * Best-effort by design. A snapshot that cannot be stored must never fail a build that is otherwise fine, so the
   * caller logs and continues; the platform refuses a repeat for the same revision, so a retry cannot rewrite one.
   */
  storeRevision(job: Pick<Job, "id" | "leaseToken">, req: { cycle: number; phase: "build" | "repair" | "final"; commit?: string | null; score?: number | null; decision?: string | null; isBest?: boolean; reverted?: boolean; revertedReason?: string | null; effect?: "effective" | "ineffective" | "unknown" | null; effectReason?: string | null; files: { path: string; base64: string }[] }): Promise<{ revisionId: string; stored: number; alreadyStored: boolean }> {
    return this.post("/api/builds/runner/revisions/store", { jobId: job.id, leaseToken: job.leaseToken, ...req }, { jobId: job.id });
  }

  checkpoint(job: Pick<Job, "id" | "leaseToken">, req: CheckpointRequest): Promise<{ checkpointKey: string | null }> {
    return this.post("/api/builds/runner/checkpoint", { jobId: job.id, leaseToken: job.leaseToken, ...req }, { jobId: job.id });
  }

  requirements(job: Pick<Job, "id" | "leaseToken">, items: RequirementItem[]): Promise<unknown> {
    return this.post("/api/builds/runner/requirements", { jobId: job.id, leaseToken: job.leaseToken, items }, { jobId: job.id });
  }

  file(job: Pick<Job, "id" | "leaseToken">, fileId: string): Promise<{ name: string; contentType: string; base64: string }> {
    return this.post("/api/builds/runner/files", { jobId: job.id, leaseToken: job.leaseToken, fileId }, { jobId: job.id });
  }

  /**
   * PROPOSED endpoint (not in protocol v1): fetch a previously uploaded checkpoint archive so a different runner host
   * can resume. A 404/405 answer means "not supported" and the caller falls back to git source / a new session.
   */
  async fetchCheckpoint(job: Pick<Job, "id" | "leaseToken">, checkpointKey: string): Promise<{ archiveBase64: string } | null> {
    try {
      return await this.post<{ archiveBase64: string }>("/api/builds/runner/checkpoint/fetch",
        { jobId: job.id, leaseToken: job.leaseToken, checkpointKey }, { jobId: job.id });
    } catch (err) {
      if (err instanceof ControlPlaneError && (err.status === 404 || err.status === 405)) return null;
      throw err;
    }
  }

  /** Preview lifecycle (v1.2): previews the platform wants deleted. null = the platform does not offer it (404/405). */
  async expiredPreviews(): Promise<ExpiredPreview[] | null> {
    try {
      const r = await this.post<ExpiredPreviewsResponse>("/api/builds/runner/previews/claim", { runnerId: this.opts.runnerId.slice(0, LIMITS.runnerId) });
      return Array.isArray(r.previews) ? r.previews.slice(0, 20) : [];
    } catch (err) {
      if (err instanceof ControlPlaneError && (err.status === 404 || err.status === 405)) return null;
      throw err;
    }
  }

  /** Customer production delivery: one Owner-authorized release (or null). null result = the platform has no such endpoint. */
  async claimDeployment(capabilities: string[]): Promise<SiteDeployment | null | "unsupported"> {
    try {
      const r = await this.post<DeploymentClaimResponse>("/api/builds/runner/deployments/claim", { runnerId: this.opts.runnerId.slice(0, LIMITS.runnerId), capabilities });
      return r.deployment ?? null;
    } catch (err) {
      if (err instanceof ControlPlaneError && (err.status === 404 || err.status === 405)) return "unsupported";
      throw err;
    }
  }

  completeDeployment(req: DeploymentCompleteRequest): Promise<{ state: string }> {
    return this.post("/api/builds/runner/deployments/complete", { runnerId: this.opts.runnerId.slice(0, LIMITS.runnerId), ...req, ...(req.error ? { error: req.error.slice(0, LIMITS.error) } : {}) });
  }

  previewDeleted(jobId: string, ok: boolean, error: string | null): Promise<unknown> {
    return this.post("/api/builds/runner/previews/deleted", { runnerId: this.opts.runnerId.slice(0, LIMITS.runnerId), jobId, ok, ...(error ? { error: error.slice(0, 500) } : {}) });
  }

  /** AI drafts: claim one short draft job (or {job:null}). Same HMAC signing as every runner endpoint. */
  aiClaim(): Promise<AiDraftClaimResponse> {
    return this.post<AiDraftClaimResponse>("/api/builds/runner/ai/claim", { runnerId: this.opts.runnerId.slice(0, LIMITS.runnerId) });
  }

  /** AI drafts: complete with the text (or an error) and token counts. No cost is sent: local inference has none. */
  aiComplete(job: Pick<AiDraftJob, "id" | "leaseToken">, req: AiDraftCompleteRequest): Promise<{ status: string }> {
    return this.post("/api/builds/runner/ai/complete", {
      jobId: job.id, leaseToken: job.leaseToken, model: req.model, inputTokens: req.inputTokens, outputTokens: req.outputTokens,
      ...(req.text !== undefined ? { text: req.text } : {}), ...(req.error ? { error: req.error.slice(0, LIMITS.error) } : {}),
      ...(req.correlationId ? { correlationId: req.correlationId } : {}), ...(req.diagnostic ? { diagnostic: req.diagnostic } : {}),
    }, { jobId: job.id });
  }

  /** Node 1 diagnostic: one runner-side checkpoint (D07–D11), authenticated by the job's lease token. */
  aiCheckpoint(job: Pick<AiDraftJob, "id" | "leaseToken">, correlationId: string, cp: DiagnosticCheckpoint): Promise<{ recorded: boolean }> {
    return this.post("/api/builds/runner/ai/checkpoint", { jobId: job.id, leaseToken: job.leaseToken, correlationId, ...cp, ...(cp.error ? { error: cp.error.slice(0, LIMITS.error) } : {}) }, { jobId: job.id });
  }

  complete(job: Pick<Job, "id" | "leaseToken">, req: CompleteRequest): Promise<unknown> {
    return this.post("/api/builds/runner/complete", {
      jobId: job.id, leaseToken: job.leaseToken, ...req, runCostUsd: round4(req.runCostUsd),
      report: truncateBytes(req.report, LIMITS.report),
      ...(req.error ? { error: req.error.slice(0, LIMITS.error) } : {}),
    }, { jobId: job.id });
  }
}

export function round4(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 10_000) / 10_000;
}

export function truncateBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const marker = "\n\n[report truncated to fit the 50 KB limit]\n";
  let cut = buf.subarray(0, maxBytes - Buffer.byteLength(marker)).toString("utf8");
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return cut + marker;
}
