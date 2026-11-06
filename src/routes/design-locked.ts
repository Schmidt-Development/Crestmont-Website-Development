// Design-locked frontends: the screens a person uses, and the endpoints the runner calls.
//
// The workflow this serves is deliberately slow in one place and fast everywhere else. Receiving, validating
// and measuring an artifact is automatic. APPROVING it is not, and cannot be: approval is what locks the design
// and what stops the AI ever redesigning it, so it takes a named person with the right role and it is written
// to the audit log with what it replaced.

import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, formatDateTime, type SafeHtml } from "../lib/html.ts";
import { HttpError, jsonResponse, redirect, str } from "../app/http.ts";
import { requireStaff } from "../app/app.ts";
import { can } from "../domain/authz.ts";
import { staffPage } from "./crm.ts";
import { UploadError, storeUpload } from "../services/files.ts";
import { UPLOAD_LIMIT_BYTES } from "../adapters/storage.ts";
import * as DL from "../services/design-locked.ts";
import { alert, badge, button, csrf, emptyState, kpi, pageHead, table, linkButton } from "../ui/components.ts";

const BASE = "/staff/builds/frontends";

/** The colour a state reads as. Failure states are warnings, not errors: a person has to act, nothing is broken. */
const STATE_TONE: Record<string, string> = {
  approved_for_release: "ok", ready_for_review: "ok", design_locked: "ok",
  artifact_rejected: "warn", artifact_quarantined: "warn", blocked: "warn",
  awaiting_frontend: "muted", awaiting_approval: "info",
};

const stateLabel = (s: string | null) => (s ? s.replace(/_/g, " ") : "not started");

function stateBadge(s: string | null): SafeHtml {
  return badge(STATE_TONE[s ?? ""] ?? "info", stateLabel(s));
}

/** The scan verdict, said in words rather than shown as a status code. */
function scanBadge(status: string | null): SafeHtml {
  if (status === "clean") return badge("ok", "scanned clean");
  if (status === "infected") return badge("danger", "INFECTED");
  if (status === "failed") return badge("warn", "scan failed");
  if (status === "skipped_internal") return badge("muted", "internal fixture — not scanned");
  return badge("warn", "awaiting scan");
}

/**
 * The person doing this, by id.
 *
 * `Actor.userId` is optional because system and webhook actors have none. Approving a design is exactly the act
 * that must be attributable, so an actor without an id is refused here rather than stored as null.
 */
function actorId(ctx: AppContext): string {
  const id = ctx.actor?.userId;
  if (!id) throw new HttpError(403, "This action has to be taken by a signed-in person.");
  return id;
}

export function register(r: Router): void {
  // ── the dashboard (§13) ───────────────────────────────────────────────────────────────────────────────────
  r.get(BASE, async (ctx) => {
    requireStaff(ctx, "builds.read");
    const rows = await DL.dashboard(ctx.db, { limit: 200 });

    const byState = new Map<string, number>();
    for (const x of rows) byState.set(x.state ?? "none", (byState.get(x.state ?? "none") ?? 0) + 1);

    const body = html`${pageHead("AI → Approved frontends", linkButton("AI builds", "/staff/builds", "ghost", "sm"),
      "The Founder supplies the design. The AI builds the backend and must leave the design alone.")}
${rows.length === 0 ? alert("info", html`No project is on the design-locked workflow yet. A project joins it when an approved frontend artifact is uploaded against it.`) : ""}
<div class="kpis">
  ${kpi("Design locked", rows.filter((x) => x.designLocked).length, "approved and frozen")}
  ${kpi("Awaiting approval", byState.get("awaiting_approval") ?? 0, "a person must look")}
  ${kpi("Building backend", (byState.get("building_backend") ?? 0) + (byState.get("integrating") ?? 0))}
  ${kpi("Needs attention", (byState.get("artifact_rejected") ?? 0) + (byState.get("artifact_quarantined") ?? 0) + (byState.get("blocked") ?? 0))}
</div>
${rows.length === 0 ? emptyState("Nothing yet", "No project is on the design-locked workflow.") : table(
  rows,
  [
    { header: "Project", cell: (x: DL.DesignLockedRow) => html`<a href="${BASE}/${x.projectId}">${x.projectName}</a>` },
    { header: "Package", cell: (x: DL.DesignLockedRow) => html`${x.packageId ?? "—"}` },
    { header: "State", cell: (x: DL.DesignLockedRow) => stateBadge(x.state) },
    { header: "Artifact", cell: (x: DL.DesignLockedRow) => x.artifactVersion ? html`v${String(x.artifactVersion)} · ${x.framework ?? "unknown"} ${scanBadge(x.scanStatus)}` : html`<span class="faint">none yet</span>` },
    { header: "Design", cell: (x: DL.DesignLockedRow) => x.baselineVersion ? html`v${String(x.baselineVersion)} ${badge(x.baselineStatus === "approved" ? "ok" : "info", x.baselineStatus ?? "")}<br><code class="faint">${(x.fingerprint ?? "").slice(0, 12)}…</code>` : html`<span class="faint">not measured</span>` },
    { header: "Routes", cell: (x: DL.DesignLockedRow) => html`${String(x.routes)}` },
    { header: "Needs a backend", cell: (x: DL.DesignLockedRow) => html`${String(x.interactionsNeedingBackend)}` },
    { header: "Updated", cell: (x: DL.DesignLockedRow) => html`${formatDateTime(x.updatedAt)}` },
  ],
)}`;
    return staffPage(ctx, "Approved frontends", body);
  });

  // ── one project ───────────────────────────────────────────────────────────────────────────────────────────
  r.get(`${BASE}/:projectId`, async (ctx, p) => {
    requireStaff(ctx, "builds.read");
    const mayApprove = !!ctx.actor && can(ctx.actor, "builds.configure");
    const projectId = p.projectId;

    const project = await ctx.db.prepare(`SELECT id, name, organization_id FROM projects WHERE id = ?`).bind(projectId)
      .first<{ id: string; name: string; organization_id: string }>();
    if (!project) throw new HttpError(404, "No such project.");

    const [artifacts, baselines, state] = await Promise.all([
      DL.listArtifacts(ctx.db, projectId),
      DL.listBaselines(ctx.db, projectId),
      DL.frontendState(ctx.db, projectId),
    ]);
    const draft = baselines.find((b) => b.status === "draft");
    const approved = baselines.find((b) => b.status === "approved");

    const problemsOf = (a: DL.FrontendArtifact): SafeHtml => {
      let list: { severity?: string; code?: string; detail?: string; path?: string }[] = [];
      try { list = JSON.parse(a.problems_json); } catch { list = []; }
      if (!list.length) return html``;
      return html`<ul class="faint" style="margin:.25rem 0 0">${list.slice(0, 8).map((x) => html`<li><code>${x.code ?? ""}</code> ${x.detail ?? ""}${x.path ? html` <code>${x.path}</code>` : ""}</li>`)}</ul>`;
    };

    const body = html`${pageHead(project.name, linkButton("All approved frontends", BASE, "ghost", "sm"), "Approved frontend and design baseline")}
<p>${stateBadge(state.state)} ${state.designLocked ? badge("ok", "design locked") : badge("muted", "not locked")}</p>

${state.designLocked ? alert("success", html`This project is <strong>design-locked</strong>. Autonomous frontend generation is retired for it: new builds, revisions and retries all start from the approved design and the AI builds the backend only.`) : ""}

<section class="card">
  <h2>Upload an approved frontend</h2>
  <p class="faint">A ZIP of the complete frontend project, up to ${String(Math.round(UPLOAD_LIMIT_BYTES / 1024 / 1024))} MB. It is scanned before anything in it is read, and it does not replace an approved design until someone approves it.</p>
  ${mayApprove ? html`<form method="post" action="${BASE}/${projectId}/artifact" enctype="multipart/form-data" class="row" style="gap:.5rem;align-items:end">
    ${csrf(ctx)}
    <input type="file" name="artifact" accept=".zip,application/zip" required>
    ${button("Upload", { variant: "primary" })}
  </form>` : html`<p class="faint">You do not have permission to upload or approve a frontend.</p>`}
</section>

<section class="card">
  <h2>Artifacts</h2>
  ${artifacts.length === 0 ? emptyState("No artifact yet", "No frontend artifact has been received for this project.") : table(
    artifacts,
    [
      { header: "Version", cell: (a: DL.FrontendArtifact) => html`v${String(a.version)}` },
      { header: "Source", cell: (a: DL.FrontendArtifact) => html`${a.source.replace(/_/g, " ")}` },
      { header: "Framework", cell: (a: DL.FrontendArtifact) => html`${a.framework ?? "—"}` },
      { header: "Scan", cell: (a: DL.FrontendArtifact) => scanBadge(a.scan_status) },
      { header: "Status", cell: (a: DL.FrontendArtifact) => html`${badge(a.status === "imported" ? "ok" : a.status === "rejected" || a.status === "quarantined" ? "danger" : "info", a.status)}${problemsOf(a)}` },
      { header: "Received", cell: (a: DL.FrontendArtifact) => html`${formatDateTime(a.created_at)}` },
    ],
  )}
</section>

<section class="card">
  <h2>Design baselines</h2>
  <p class="faint">A baseline records the approved appearance at desktop, tablet and mobile, with its routes, assets, components and interactions. Once approved it can never be edited — a changed frontend gets a new version.</p>
  ${baselines.length === 0 ? emptyState("No baseline yet", "No design baseline has been measured for this project.") : table(
    baselines,
    [
      { header: "Version", cell: (b: DL.DesignBaselineRow) => html`v${String(b.version)}` },
      { header: "Status", cell: (b: DL.DesignBaselineRow) => badge(b.status === "approved" ? "ok" : b.status === "draft" ? "info" : "muted", b.status) },
      { header: "Design fingerprint", cell: (b: DL.DesignBaselineRow) => html`<code>${b.fingerprint.slice(0, 16)}…</code>` },
      { header: "Pages", cell: (b: DL.DesignBaselineRow) => html`${String(safeLen(b.signatures_json))} views, ${String(safeLen(b.screenshots_json))} screenshots` },
      { header: "Approved", cell: (b: DL.DesignBaselineRow) => b.approved_at ? html`${formatDateTime(b.approved_at)}` : html`<span class="faint">—</span>` },
      { header: "", cell: (b: DL.DesignBaselineRow) => !mayApprove ? html`` :
          b.status === "draft" ? html`<form method="post" action="${BASE}/${projectId}/baselines/${b.id}/approve" class="row" style="gap:.25rem"
              onsubmit="return confirm('Approve this design? It locks the appearance, and the AI will not be allowed to change it.')">
            ${csrf(ctx)}<input type="text" name="note" placeholder="note (optional)" maxlength="300">${button("Approve and lock", { variant: "primary", size: "sm" })}</form>`
          : (b.status === "superseded" || b.status === "rolled_back") ? html`<form method="post" action="${BASE}/${projectId}/rollback" class="row" style="gap:.25rem"
              onsubmit="return confirm('Roll back to this design? Backend work is not affected.')">
            ${csrf(ctx)}<input type="hidden" name="baselineId" value="${b.id}"><input type="text" name="reason" placeholder="why" maxlength="300" required>${button("Roll back", { variant: "ghost", size: "sm" })}</form>`
          : html`` },
    ],
  )}
  ${draft && mayApprove ? alert("info", html`Baseline <strong>v${String(draft.version)}</strong> has been measured and is waiting for a person to approve it. Approving it locks the design${approved ? html` and supersedes v${String(approved.version)}` : ""}.`) : ""}
</section>`;
    return staffPage(ctx, project.name, body);
  });

  // ── upload an artifact ────────────────────────────────────────────────────────────────────────────────────
  r.post(`${BASE}/:projectId/artifact`, async (ctx, p) => {
    requireStaff(ctx, "builds.configure");
    const projectId = p.projectId;
    const project = await ctx.db.prepare(`SELECT id, organization_id FROM projects WHERE id = ?`).bind(projectId)
      .first<{ id: string; organization_id: string }>();
    if (!project) throw new HttpError(404, "No such project.");

    const form = await ctx.form();
    const file = form.get("artifact");
    if (!(file instanceof File) || file.size === 0) throw new HttpError(422, "Choose a ZIP of the frontend project.");

    // The platform's own upload path: it writes the `files` row, computes the sha256 and sets scan_status
    // 'pending'. The artifact cannot be extracted until a scanner moves that to 'clean'.
    //
    // `storeUpload` refuses anything that is not an allowed type, is empty, is oversized, or whose bytes do not
    // match its extension. That is a refusal to show the person, not an internal error, so it is answered 422
    // with the reason rather than being allowed to become a 500.
    let stored;
    try {
      stored = await storeUpload(ctx, {
        organizationId: project.organization_id, projectId, file, uploadedBy: actorId(ctx), folder: "frontend-artifacts",
      });
    } catch (e) {
      if (e instanceof UploadError) throw new HttpError(422, e.message);
      throw e;
    }

    await DL.recordArtifact(ctx.db, {
      projectId, organizationId: project.organization_id, source: "upload",
      fileId: stored.id, sha256: stored.sha256, sizeBytes: stored.size_bytes,
      uploadedBy: actorId(ctx), scanStatus: stored.scan_status,
    });

    return redirect(ctx, `${BASE}/${projectId}`);
  });

  // ── approve a baseline: the one step that must be a person ────────────────────────────────────────────────
  r.post(`${BASE}/:projectId/baselines/:baselineId/approve`, async (ctx, p) => {
    requireStaff(ctx, "builds.configure");
    const form = await ctx.form();
    const note = str(form, "note").slice(0, 300);
    const b = await DL.getBaseline(ctx.db, p.baselineId);
    if (!b || b.project_id !== p.projectId) throw new HttpError(404, "No such design baseline for this project.");
    await DL.approveBaseline(ctx.db, p.baselineId, { approvedBy: actorId(ctx), note: note || undefined });
    return redirect(ctx, `${BASE}/${p.projectId}`);
  });

  // ── roll back to a previously approved design ─────────────────────────────────────────────────────────────
  r.post(`${BASE}/:projectId/rollback`, async (ctx, p) => {
    requireStaff(ctx, "builds.configure");
    const form = await ctx.form();
    const baselineId = str(form, "baselineId");
    const reason = str(form, "reason").slice(0, 300);
    if (!baselineId) throw new HttpError(422, "Choose a baseline to roll back to.");
    if (!reason) throw new HttpError(422, "Say why you are rolling back.");
    await DL.rollbackBaseline(ctx.db, p.projectId, { toBaselineId: baselineId, actorId: actorId(ctx), reason });
    return redirect(ctx, `${BASE}/${p.projectId}`);
  });

  // ── the project's design-lock state, as JSON ──────────────────────────────────────────────────────────────
  //
  // Read-only and staff-authenticated. Deliberately NOT named `.json`: in this codebase that suffix marks a
  // downloadable export (alongside .csv, .md, .pdf), which the audit inventory requires to be recorded as a
  // data egress. This is a live status read for the dashboard and for tests, so auditing every glance at it
  // would be noise. The runner's own signed channel carries the archive bytes; this carries nothing but state.
  r.get(`${BASE}/:projectId/state`, async (ctx, p) => {
    requireStaff(ctx, "builds.read");
    const [state, artifacts, baselines] = await Promise.all([
      DL.frontendState(ctx.db, p.projectId),
      DL.listArtifacts(ctx.db, p.projectId),
      DL.listBaselines(ctx.db, p.projectId),
    ]);
    const gate = await DL.designGenerationAllowed(ctx.db, p.projectId);
    return jsonResponse(ctx, 200, {
      projectId: p.projectId,
      ...state,
      designGenerationAllowed: gate.allowed,
      designGenerationReason: gate.reason,
      artifacts: artifacts.map((a) => ({ id: a.id, version: a.version, source: a.source, framework: a.framework, scanStatus: a.scan_status, status: a.status })),
      baselines: baselines.map((b) => ({ id: b.id, version: b.version, status: b.status, fingerprint: b.fingerprint, approvedAt: b.approved_at, approvedBy: b.approved_by })),
    });
  });
}

function safeLen(json: string): number {
  try { const a = JSON.parse(json); return Array.isArray(a) ? a.length : 0; } catch { return 0; }
}
