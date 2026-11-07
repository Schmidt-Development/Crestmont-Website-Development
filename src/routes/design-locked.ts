// Design-locked frontends: the screens a person uses, and the endpoints the runner calls.
//
// The workflow this serves is deliberately slow in one place and fast everywhere else. Receiving, validating
// and measuring an artifact is automatic. APPROVING it is not, and cannot be: approval is what locks the design
// and what stops the AI ever redesigning it, so it takes a named person with the right role and it is written
// to the audit log with what it replaced.

import type { Router } from "../lib/router.ts";
import type { AppContext } from "../app/context.ts";
import { html, join, formatDateTime, type SafeHtml } from "../lib/html.ts";
import { HttpError, jsonResponse, redirect, str } from "../app/http.ts";
import { requireStaff } from "../app/app.ts";
import { can } from "../domain/authz.ts";
import { staffPage } from "./crm.ts";
import { UploadError, storeUpload } from "../services/files.ts";
import { UPLOAD_LIMIT_BYTES } from "../adapters/storage.ts";
import * as DL from "../services/design-locked.ts";
import { syncProjectBuild, getBuildSettings, projectFacts, decideEligibility, queueSnapshot, startBackendBuild } from "../services/builds.ts";
import * as AA from "../services/artifact-assets.ts";
import { audit } from "../services/security.ts";
import { alert, badge, button, csrf, emptyState, kpi, pageHead, table, linkButton } from "../ui/components.ts";

const BASE = "/staff/builds/frontends";

/**
 * Receive an artifact for a project. Both entry points go through this, so neither can lose a check.
 *
 * `storeUpload` is the platform's own upload path: it writes the `files` row, computes the sha256 and sets
 * scan_status 'pending'. Nothing in the ZIP is read until a scanner moves that to 'clean'. It refuses anything
 * that is not an allowed type, is empty, is oversized, or whose bytes do not match its extension -- a refusal to
 * show the person, so it is answered 422 with the reason rather than becoming a 500.
 */
async function receiveArtifact(
  ctx: AppContext,
  o: { projectId: string; organizationId: string; file: File; approveOnMeasure?: boolean },
): Promise<void> {
  let stored;
  try {
    stored = await storeUpload(ctx, {
      organizationId: o.organizationId, projectId: o.projectId, file: o.file,
      uploadedBy: actorId(ctx), folder: "frontend-artifacts",
    });
  } catch (e) {
    if (e instanceof UploadError) throw new HttpError(422, e.message);
    throw e;
  }
  await DL.recordArtifact(ctx.db, {
    projectId: o.projectId, organizationId: o.organizationId, source: "upload",
    fileId: stored.id, sha256: stored.sha256, sizeBytes: stored.size_bytes,
    uploadedBy: actorId(ctx), scanStatus: stored.scan_status,
    // Not an approval. It records that this person, submitting this upload, says it is the approved design; it
    // becomes an approval only once the artifact has been scanned clean, imported and measured.
    approvalIntentBy: o.approveOnMeasure ? actorId(ctx) : null,
  });
}


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

/**
 * What a missing dependency does to the design, in words an owner can act on.
 *
 * The runner says the same thing in `external-assets.ts` for the import record; this is the page's copy, because
 * the page reads rows rather than an import outcome. "It failed" is not something anyone can decide about; "your
 * typeface is not there, so the letterforms and line breaks are different" is.
 */
function assetImpact(kind: string, url: string): string {
  const host = (() => { try { return new URL(url).host; } catch { return "an external host"; } })();
  if (kind === "font") return `the typeface served by ${host} is not available, so this text renders in a fallback font: different letterforms, widths and line breaks`;
  if (kind === "image") return `the image served by ${host} is not available, so this element renders empty or with its alternative text`;
  if (kind === "stylesheet") return `the stylesheet served by ${host} is not available, so everything it styles renders unstyled — this usually changes the whole page`;
  return `the resource served by ${host} is not available`;
}

export function register(r: Router): void {
  // ── the dashboard (§13) ───────────────────────────────────────────────────────────────────────────────────
  r.get(BASE, async (ctx) => {
    requireStaff(ctx, "builds.read");
    const rows = await DL.dashboard(ctx.db, { limit: 200 });
    // What is running and what is waiting, in the order the next claim will take them. Shown here because this is
    // the screen someone watches after submitting, and "queued" with no position is indistinguishable from stuck.
    const queue = await queueSnapshot(ctx.db);

    const byState = new Map<string, number>();
    for (const x of rows) byState.set(x.state ?? "none", (byState.get(x.state ?? "none") ?? 0) + 1);

    // The upload control belongs here, where someone arrives with a ZIP and nothing else. It was reachable only
    // from a project's own page, which does not exist until an artifact has been uploaded against it.
    const mayUpload = !!ctx.actor && can(ctx.actor, "builds.configure");
    const body = html`${pageHead("AI → Approved frontends",
      html`${mayUpload ? linkButton("Upload frontend artifact", `${BASE}/new`, "primary", "sm") : ""}${linkButton("AI builds", "/staff/builds", "ghost", "sm")}`,
      "The Founder supplies the design. The AI builds the backend and must leave the design alone.")}
${rows.length === 0 ? alert("info", html`No project is on the design-locked workflow yet. ${mayUpload ? html`Start by uploading a frontend ZIP: <a href="${BASE}/new">Upload frontend artifact</a>. A test project is created for it, so nothing needs to be set up first.` : html`A project joins it when an approved frontend artifact is uploaded against it.`}`) : ""}
<div class="kpis">
  ${kpi("Design locked", rows.filter((x) => x.designLocked).length, "approved and frozen")}
  ${kpi("Awaiting approval", byState.get("awaiting_approval") ?? 0, "a person must look")}
  ${kpi("Active builds", `${queue.active.length} / ${queue.cap}`, queue.active.length >= queue.cap ? "every slot in use" : `${queue.cap - queue.active.length} slot(s) free`, (queue.active.length / Math.max(1, queue.cap)) * 100)}
  ${kpi("Waiting", queue.queued.length, queue.queued.length ? "starts automatically as slots free" : "nothing queued")}
  ${kpi("Needs attention", (byState.get("artifact_rejected") ?? 0) + (byState.get("artifact_quarantined") ?? 0) + (byState.get("blocked") ?? 0))}
</div>

${queue.active.length || queue.queued.length ? html`<section class="card">
  <h2>Backend builds</h2>
  <p class="faint">At most ${String(queue.cap)} run at once. The rest wait in order and start on their own as slots are released; nobody has to press anything.</p>
  ${queue.active.length ? table(queue.active, [
    { header: "Slot", cell: (x: typeof queue.active[number]) => html`${String(queue.active.indexOf(x) + 1)} of ${String(queue.cap)}` },
    { header: "Project", cell: (x: typeof queue.active[number]) => html`<a href="${BASE}/${x.projectId}">${x.projectName}</a>` },
    { header: "State", cell: (x: typeof queue.active[number]) => badge("info", x.state) },
    { header: "Started", cell: (x: typeof queue.active[number]) => html`${x.startedAt ? formatDateTime(x.startedAt) : "—"}` },
    { header: "Runner", cell: (x: typeof queue.active[number]) => html`<span class="faint">${x.runner ?? "—"}</span>` },
  ]) : html`<p class="faint">No build is running.</p>`}
  ${queue.queued.length ? html`<h3>Queue</h3>${table(queue.queued, [
    { header: "Position", cell: (x: typeof queue.queued[number]) => html`${String(x.position)}` },
    { header: "Project", cell: (x: typeof queue.queued[number]) => html`<a href="${BASE}/${x.projectId}">${x.projectName}</a>` },
    { header: "Waiting since", cell: (x: typeof queue.queued[number]) => html`${formatDateTime(x.waitingSince)}` },
  ])}` : ""}
</section>` : ""}
${rows.length === 0 ? emptyState("Nothing yet", "No project is on the design-locked workflow.", mayUpload ? linkButton("Upload frontend artifact", `${BASE}/new`, "primary") : undefined) : table(
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


  // ── start here ────────────────────────────────────────────────────────────────────────────────────────────
  //
  // The upload endpoint has always taken a project id, and the only screen offering one was a project's own page.
  // With no design-locked project yet there was nowhere to begin: a first artifact could not be uploaded without
  // making database rows by hand or going through a customer purchase. This is that screen.
  //
  // Registered BEFORE `/:projectId`, or the router reads "new" as a project id.
  r.get(`${BASE}/new`, async (ctx) => {
    requireStaff(ctx, "builds.configure");
    const targets = await DL.uploadTargets(ctx.db, { limit: 50 });
    const limitMb = String(Math.round(UPLOAD_LIMIT_BYTES / 1024 / 1024));

    const body = html`${pageHead("Upload a frontend artifact", linkButton("Back to artifact builder", BASE, "ghost", "sm"),
      "A ZIP of the finished frontend. It is scanned before anything in it is read, then measured in a sandbox. It does not become the approved design until you approve it.")}
<section class="card">
  <form method="post" action="${BASE}/new" enctype="multipart/form-data">
    ${csrf(ctx)}

    <h2>1. Which project</h2>
    ${targets.length === 0
      ? html`<p class="faint">No project exists yet, so this will create a test project for it. Nothing needs to be set up first.</p>`
      : html`<p><label><input type="radio" name="target" value="new" checked> Create a new test project</label></p>
    <p><label><input type="radio" name="target" value="existing"> Use an existing project</label>
      <select name="projectId" aria-label="Existing project">
        ${join(targets.map((t) => html`<option value="${t.projectId}">${t.projectName} — ${t.organizationName}${t.designLocked ? " (design-locked)" : ""}</option>`))}
      </select>
    </p>`}
    <p><label>Name for the test project<br><input type="text" name="name" value="Artifact test" maxlength="120" required></label></p>

    <h2>2. The ZIP</h2>
    <p class="faint">Up to ${limitMb} MB. A ZIP of the complete frontend project, as it was built.</p>
    <input type="file" name="artifact" accept=".zip,application/zip" required>

    <h2>3. Approve it now, or later</h2>
    <p><label><input type="checkbox" name="approve" value="1"> This is the approved design. Approve it automatically and start the backend.</label></p>
    <p class="faint">
      Ticking this does not approve anything yet: there is nothing to approve until the ZIP has been scanned,
      unpacked and measured. It records that you said it. The approval is then written against the design that
      was actually measured &mdash; its version, its fingerprint and this archive's own checksum &mdash; and the
      backend build is queued. An artifact that is infected, invalid or cannot be measured is never approved.
      Leave it unticked to review the measurements first and approve by hand.
    </p>

    <p style="margin-top:1rem">${button("Upload and scan", { variant: "primary" })}</p>
  </form>
</section>
<section class="card">
  <h2>What happens next</h2>
  <ol class="faint">
    <li>The ZIP is scanned for malware. Nothing inside it is read until a scanner says it is clean.</li>
    <li>It is extracted and measured in a sandbox with no network: pages, interactions, and the design signature at three viewports.</li>
    <li>You review what was measured and approve the design baseline. That is the step that locks the design.</li>
    <li>You start backend generation. The AI builds the backend around your design and may not change it.</li>
  </ol>
</section>`;
    return staffPage(ctx, "Upload a frontend artifact", body);
  });

  r.post(`${BASE}/new`, async (ctx) => {
    requireStaff(ctx, "builds.configure");
    const form = await ctx.form();
    const file = form.get("artifact");
    if (!(file instanceof File) || file.size === 0) throw new HttpError(422, "Choose a ZIP of the frontend project.");

    // Refuse the obvious before anything is created. Without this a wrong file leaves a project behind on every
    // attempt, and a dashboard fills up with the evidence of someone choosing the wrong file twice.
    if (file.size > UPLOAD_LIMIT_BYTES) {
      throw new HttpError(422, `That file is ${Math.round(file.size / 1024 / 1024)} MB. The limit is ${Math.round(UPLOAD_LIMIT_BYTES / 1024 / 1024)} MB.`);
    }
    if (!/\.zip$/i.test(file.name)) throw new HttpError(422, "Choose a .zip of the frontend project.");

    let projectId: string;
    let organizationId: string;
    let created = false;
    if (str(form, "target") === "existing") {
      projectId = str(form, "projectId");
      const row = await ctx.db.prepare(`SELECT id, organization_id FROM projects WHERE id = ?`).bind(projectId)
        .first<{ id: string; organization_id: string }>();
      if (!row) throw new HttpError(422, "Choose a project that exists.");
      organizationId = row.organization_id;
    } else {
      // A test project has no order behind it, which is exactly the point: inventing an order, an invoice and a
      // payment to try a ZIP would be worse than the problem. createTestProject marks it as internal and audits it.
      try {
        ({ projectId, organizationId } = await DL.createTestProject(ctx.db, {
          name: str(form, "name") || "Artifact test", actorId: actorId(ctx), ip: ctx.ip,
        }));
        created = true;
      } catch (e) {
        throw new HttpError(422, (e as Error).message);
      }
    }

    try {
      await receiveArtifact(ctx, { projectId, organizationId, file, approveOnMeasure: str(form, "approve") === "1" });
    } catch (e) {
      // storeUpload is the authority on what a frontend artifact may be, and it can still refuse a file that
      // passed the checks above -- bytes that do not match the extension, for one. A project created a moment ago
      // for an artifact that was refused has nothing in it and no reason to exist, so it goes with the refusal.
      if (created) await DL.deleteEmptyTestProject(ctx.db, projectId, { actorId: actorId(ctx), ip: ctx.ip });
      throw e;
    }
    return redirect(ctx, `${BASE}/${projectId}`);
  });

  // ── one project ───────────────────────────────────────────────────────────────────────────────────────────
  r.get(`${BASE}/:projectId`, async (ctx, p) => {
    requireStaff(ctx, "builds.read");
    const mayApprove = !!ctx.actor && can(ctx.actor, "builds.configure");
    const projectId = p.projectId;

    const project = await ctx.db.prepare(`SELECT id, name, organization_id FROM projects WHERE id = ?`).bind(projectId)
      .first<{ id: string; name: string; organization_id: string }>();
    if (!project) throw new HttpError(404, "No such project.");

    const [artifacts, baselines, state, contract] = await Promise.all([
      DL.listArtifacts(ctx.db, projectId),
      DL.listBaselines(ctx.db, projectId),
      DL.frontendState(ctx.db, projectId),
      DL.activeContract(ctx.db, projectId),
    ]);
    const draft = baselines.find((b) => b.status === "draft");
    const approved = baselines.find((b) => b.status === "approved");

    // The newest measurement, approved or not: a draft is what a person is being asked to approve, so it is what
    // they need to see.
    const measured = draft ?? approved ?? baselines[0] ?? null;
    const routes = measured ? safeArr(measured.route_manifest_json) : [];
    const interactions = measured ? safeArr(measured.interaction_inventory_json) : [];
    const views = measured ? safeArr(measured.signatures_json) : [];
    const needsBackend = interactions.filter((i) => i.needsBackend === true && i.undetermined !== true);
    const undetermined = interactions.filter((i) => i.undetermined === true);

    // Whether a build can be started, decided by the platform's own rule rather than a second one invented here.
    const [facts, settings, jobRows] = await Promise.all([
      projectFacts(ctx.db, projectId),
      getBuildSettings(ctx.db),
      ctx.db.prepare(`SELECT id, state, state_reason, stop_reason, attempts, max_attempts, preview_url, report_md, finished_at
                        FROM build_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 10`).bind(projectId).all(),
    ]);
    const eligibility = decideEligibility(facts);
    const automationOff = !settings.automation_enabled;
    const jobs = (jobRows.results ?? []) as Record<string, unknown>[];
    const latestReport = jobs.map((j) => j.report_md).find((r) => typeof r === "string" && r.trim()) as string | undefined;

    // The two values a contract has to declare about the design it is written against, resolved once and shown
    // on the contract form: whoever writes one needs them exactly, and guessing is what a refusal is for.
    const approvedBaselineRow = baselines.find((b) => b.id === state.activeBaselineId);
    const approvedFingerprint = approvedBaselineRow?.fingerprint ?? "—";
    const approvedArtifactSha = artifacts.find((a) => a.id === approvedBaselineRow?.artifact_id)?.sha256 ?? "—";

    // What the contract could not establish from the frontend. Shown, because a flagged requirement that nobody
    // reads is the same as an invented one: the work stops in the same place and nobody knows why.
    const reviewFlags = contract ? safeArr(contract.review_flags_json) : [];

    // The external assets this design depends on. The measurement has no network, so these were downloaded once
    // and written into the artifact; the ones that could not be are the reason approval is refused, and they are
    // shown where the approving happens rather than buried in a column.
    const assetRows: AA.ArtifactAssetRow[] = measured ? await AA.listAssets(ctx.db, measured.artifact_id) : [];
    const missingAssets = assetRows.filter((a) => a.status === "refused" && ["image", "font", "stylesheet"].includes(a.kind));
    const pinnedAssets = assetRows.filter((a) => a.status === "pinned");

    // Two shapes reach this column, and only one of them used to render.
    //
    // `validateArtifact` produces objects ({severity, code, detail, path}); the IMPORT reports plain strings --
    // `describeIngest`'s multi-line account, a build error, a measurement failure. A string has no `.code` and no
    // `.detail`, so every imported-or-rejected artifact's reasons rendered as empty bullets. The Founder's law
    // firm upload was refused with two precise, actionable sentences and the project page showed two blank lines.
    const problemsOf = (a: DL.FrontendArtifact): SafeHtml => {
      let list: unknown[] = [];
      try { const v = JSON.parse(a.problems_json); list = Array.isArray(v) ? v : []; } catch { list = []; }
      if (!list.length) return html``;
      const line = (x: unknown): SafeHtml => {
        if (typeof x === "string") {
          // Multi-line, because describeIngest's account is several lines and each one says something different.
          return html`<li style="white-space:pre-wrap">${x.slice(0, 2000)}</li>`;
        }
        const p = (x ?? {}) as { code?: string; detail?: string; path?: string };
        if (!p.code && !p.detail) return html`<li>${JSON.stringify(x).slice(0, 400)}</li>`;
        return html`<li><code>${p.code ?? ""}</code> ${p.detail ?? ""}${p.path ? html` <code>${p.path}</code>` : ""}</li>`;
      };
      return html`<ul class="faint" style="margin:.25rem 0 0">${join(list.slice(0, 8).map(line))}</ul>`;
    };

    // Offering a rejected artifact for import again. The archive is still in R2 and still scanned clean, so when
    // the importer was wrong about it there has to be a way back that is not "upload the same bytes again". The
    // service re-reads the scan verdict and refuses anything but the project's latest rejected artifact.
    const latestArtifactId = artifacts[0]?.id ?? null;
    const retryOf = (a: DL.FrontendArtifact): SafeHtml => {
      if (a.status !== "rejected" || a.id !== latestArtifactId || !mayApprove) return html``;
      return html`<form method="post" action="${BASE}/${projectId}/artifacts/${a.id}/retry-import" style="margin:.4rem 0 0">
        ${csrf(ctx)}
        ${button("Import again", { variant: "ghost", size: "sm" })}
        <span class="faint">The same archive, scanned again as clean before anything is unpacked.</span>
      </form>`;
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
      { header: "Status", cell: (a: DL.FrontendArtifact) => html`${badge(a.status === "imported" ? "ok" : a.status === "rejected" || a.status === "quarantined" ? "danger" : "info", a.status)}${problemsOf(a)}${retryOf(a)}` },
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
  ${missingAssets.length
    ? alert("error", html`<strong>This design cannot be approved yet.</strong>
        It depends on ${String(missingAssets.length)} external visual asset${missingAssets.length === 1 ? "" : "s"} that could not be acquired, so
        what was measured is not what the website looks like &mdash; approving it would lock in a fallback.
        Package ${missingAssets.length === 1 ? "it" : "them"} inside the archive, or make ${missingAssets.length === 1 ? "it" : "them"} publicly readable, and import again.
        <ul>${join(missingAssets.slice(0, 10).map((m) => html`<li>
          <code>${m.kind}</code> <code class="faint">${m.url.slice(0, 160)}</code>
          ${m.referenced_by ? html` &middot; referenced by <code class="faint">${m.referenced_by}</code>` : ""}
          <br><span class="faint">${m.why ?? "it could not be acquired"} &mdash; ${assetImpact(m.kind, m.url)}</span>
        </li>`))}</ul>`)
    : ""}
  ${pinnedAssets.length
    ? html`<p class="faint">${String(pinnedAssets.length)} external asset${pinnedAssets.length === 1 ? "" : "s"}
        (${[...new Set(pinnedAssets.map((a) => a.kind))].join(", ")}) were downloaded once and written into the artifact, so the
        design is measured, built and verified with exactly these bytes. Nothing is fetched again.</p>`
    : ""}
</section>

${measured ? html`<section class="card">
  <h2>The imported frontend</h2>
  <p class="faint">What a real browser found in the submitted artifact, measured at desktop, tablet and mobile. The inventory below is what the AI is asked to make work; the design itself is not its to change.</p>
  <div class="grid grid-3">
    ${kpi("Pages", String(routes.length))}
    ${kpi("Waiting on a backend", String(needsBackend.length))}
    ${kpi("Undetermined", String(undetermined.length))}
  </div>
  ${routes.length ? table(routes, [
      { header: "Page", cell: (x: Record<string, unknown>) => html`<code>${String(x.page ?? "")}</code>` },
      { header: "Title", cell: (x: Record<string, unknown>) => html`${String(x.title ?? "\u2014")}` },
    ]) : ""}
  <h3 style="font-size:1rem;margin-top:1rem">Waiting on a backend</h3>
  ${needsBackend.length === 0 ? html`<p class="faint">Nothing in this frontend needs a backend.</p>` : table(needsBackend, [
      { header: "Page", cell: (x: Record<string, unknown>) => html`<code>${String(x.page ?? "")}</code>` },
      { header: "Element", cell: (x: Record<string, unknown>) => html`<code>${String(x.element ?? "")}</code>` },
      { header: "What it is", cell: (x: Record<string, unknown>) => html`${String(x.label ?? x.role ?? "\u2014")}` },
    ])}
  ${undetermined.length ? html`<h3 style="font-size:1rem;margin-top:1rem">Could not be read from the markup</h3>
    <p class="faint">Recorded as questions rather than guessed at. Each one is something to decide before it is built.</p>
    ${table(undetermined, [
      { header: "Page", cell: (x: Record<string, unknown>) => html`<code>${String(x.page ?? "")}</code>` },
      { header: "Element", cell: (x: Record<string, unknown>) => html`<code>${String(x.element ?? "")}</code>` },
      { header: "What it is", cell: (x: Record<string, unknown>) => html`${String(x.label ?? x.role ?? "\u2014")}` },
    ])}` : ""}
</section>` : ""}

<section class="card">
  <h2>The submitted artifact</h2>
  <p class="faint">The exact bytes that were uploaded, and the design measured from them. Downloading one is recorded against your account.</p>
  ${artifacts.length === 0 ? html`<p class="faint">Nothing has been uploaded for this project yet.</p>` : table(artifacts, [
      { header: "Version", cell: (a: DL.FrontendArtifact) => html`v${String(a.version)}` },
      { header: "Scan", cell: (a: DL.FrontendArtifact) => scanBadge(a.scan_status) },
      { header: "Size", cell: (a: DL.FrontendArtifact) => html`${String(Math.round(a.size_bytes / 1024))} KB` },
      { header: "SHA-256", cell: (a: DL.FrontendArtifact) => html`<code>${a.sha256.slice(0, 16)}\u2026</code>` },
      { header: "", cell: (a: DL.FrontendArtifact) => a.file_id
          ? linkButton("Download the ZIP", `/files/${a.file_id}`, "ghost", "sm")
          : html`<span class="faint">no stored file</span>` },
      { header: "", cell: (a: DL.FrontendArtifact) => !mayApprove || a.status === "rejected" || a.status === "quarantined" ? html`` :
          html`<form method="post" action="${BASE}/${projectId}/artifacts/${a.id}/reject" class="row" style="gap:.25rem"
              onsubmit="return confirm('Reject this artifact? The project moves to artifact_rejected and nothing is built from it.')">
            ${csrf(ctx)}<input type="text" name="reason" placeholder="why" maxlength="300" required>${button("Reject", { variant: "ghost", size: "sm" })}</form>` },
    ])}
  ${measured ? html`<h3 style="font-size:1rem;margin-top:1rem">The measured design</h3>
    <p class="faint">There are no stored screenshots to show you: a baseline records each view's fingerprint, not its image. What was measured is below, and the artifact itself is downloadable above.</p>
    ${table(views.slice(0, 24), [
      { header: "Page", cell: (x: Record<string, unknown>) => html`<code>${String(x.page ?? "")}</code>` },
      { header: "Viewport", cell: (x: Record<string, unknown>) => html`${String(x.viewport ?? "")}` },
      { header: "Landmarks", cell: (x: Record<string, unknown>) => html`${String((x.skeleton as unknown[] | undefined)?.length ?? 0)}` },
      { header: "Palette", cell: (x: Record<string, unknown>) => html`${String((x.palette as unknown[] | undefined)?.length ?? 0)} colours` },
      { header: "Fonts", cell: (x: Record<string, unknown>) => html`${((x.fonts as string[] | undefined) ?? []).slice(0, 2).join(", ") || "\u2014"}` },
    ])}` : ""}
</section>

<section class="card">
  <h2>The integration contract</h2>
  <p class="faint">
    What the backend will do, written down before it starts: which operations, against which pages and elements of
    the approved design, and how each is to be accepted. A build is judged against this &mdash; the first of the
    three gates is conformance to it &mdash; so a build cannot start without one, and the model that does the work
    never writes it. Model A drafts it from the measured frontend when an artifact is imported; the platform
    validates every draft against that measurement before recording it, and you can replace it below.
  </p>

  ${contract
    ? html`<p>
        ${badge("ok", `v${String(contract.version)}`)}
        ${String(contract.operations)} operation${contract.operations === 1 ? "" : "s"},
        ${String(contract.visual_states)} declared visual state${contract.visual_states === 1 ? "" : "s"}
        &middot; recorded ${formatDateTime(contract.created_at)}
        &middot; against design <code class="faint">${contract.design_fingerprint.slice(0, 12)}&hellip;</code>
        &middot; ${contract.authored_by === "model-a"
          ? html`drafted by Model A${contract.author_model ? html` (<code class="faint">${contract.author_model}</code>)` : ""}`
          : "written by hand"}
      </p>
      ${contract.note ? html`<p class="faint">${contract.note}</p>` : ""}
      ${reviewFlags.length
        ? alert("warn", html`This contract records ${String(reviewFlags.length)} requirement${reviewFlags.length === 1 ? "" : "s"} that could not be established from the frontend. ${""}
            They were flagged rather than invented, and the operations they block cannot be finished until someone settles them:
            <ul>${join(reviewFlags.map((f) => html`<li><strong>${String(f.what ?? "")}</strong> &mdash; ${String(f.why ?? "")}${Array.isArray(f.blocks) && f.blocks.length ? html` (blocks ${f.blocks.map(String).join(", ")})` : ""}</li>`))}</ul>`)
        : ""}
      <details><summary>The contract as recorded</summary><pre style="white-space:pre-wrap;max-height:24rem;overflow:auto">${JSON.stringify(JSON.parse(contract.manifest_json), null, 2)}</pre></details>`
    : alert("warn", html`No contract has been recorded for this project, so a backend build will stop as soon as it starts: <strong>there is nothing for it to build against and nothing to verify an implementation with</strong>. One is drafted automatically when an artifact is imported and measured; if none appeared, the drafts were refused by the validator and the reasons are in the audit log. Record one below.`)}

  ${!state.designLocked
    ? html`<p class="faint">A contract is written against an approved design, so approve one first.</p>`
    : mayApprove
      ? html`<form method="post" action="${BASE}/${projectId}/contract" class="stack">
          ${csrf(ctx)}
          <label for="f-manifest">The contract (JSON)</label>
          <textarea id="f-manifest" name="manifest" rows="12" required placeholder='{"schema":"crestmont.integration-manifest/1", ...}'
            style="width:100%;font-family:ui-monospace,monospace;font-size:.85rem"></textarea>
          <p class="faint">
            Checked against the design that was actually measured before it is stored: the artifact checksum and
            design fingerprint must be this project's, and every page and element it names must exist in the
            approved frontend. A contract that does not match is refused with the reasons, not stored and
            discovered later.
          </p>
          <p class="faint">
            A contract declares the design it was written against, and these are this project's two values.
            Copy them in: <code>artifactSha</code> is
            <code>${approvedArtifactSha}</code>
            and <code>designFingerprint</code> is <code>${approvedFingerprint}</code>.
            A contract naming anything else is refused rather than stretched to fit.
          </p>
          <label for="f-contract-note">Note (optional)</label>
          <input id="f-contract-note" name="note" maxlength="500" placeholder="Why this version, or what changed">
          ${button(contract ? `Replace contract v${String(contract.version)}` : "Record the contract", { variant: "primary" })}
          ${contract ? html`<span class="faint">The current version is superseded, not deleted: what an earlier build was held to stays on the record.</span>` : ""}
        </form>`
      : html`<p class="faint">You do not have permission to record a contract.</p>`}
</section>

<section class="card">
  <h2>Backend development</h2>
  <p class="faint">The AI builds the backend behind the approved design and never the design itself. Three independent gates judge the result \u2014 the contract, the application actually working, and the design still matching \u2014 and the model does not decide whether its own work passed.</p>

  ${state.designLocked && !contract
    ? alert("warn", "A backend job also needs an integration contract, and this project has none, so it has not been queued: a build without one stops as soon as it starts. One is drafted automatically when an artifact is imported; if none is here, every draft was refused by the validator, and the reasons are in the audit log. You can also record one above.")
    : ""}
  ${!state.designLocked
    ? alert("info", "A backend job can start once a design baseline is approved. Approve one above.")
    : eligibility.verdict !== "queued"
      ? alert("warn", html`This project is design-locked, but the platform will not queue a build yet: <strong>${eligibility.reasons.join("; ")}</strong>. That is the same rule every build follows, so the thing to fix is the project, not this page.${automationOff ? html` Automatic starts are also switched off in <a href="/staff/builds">AI builds</a> settings.` : ""}`)
      : mayApprove
        ? html`<form method="post" action="${BASE}/${projectId}/build" class="row" style="gap:.5rem;align-items:center"
            onsubmit="return confirm('Start a backend development job against the approved design?')">
          ${csrf(ctx)}${button("Start a backend job", { variant: "primary" })}
          <span class="faint">Queues a build for the Node 1 runner. The approved design is handed to it and cannot be changed by it.</span>
        </form>`
        : html`<p class="faint">You do not have permission to start a build.</p>`}

  ${jobs.length === 0 ? emptyState("No backend job yet", "Nothing has been built against this design.") : table(jobs, [
      { header: "Build", cell: (j: Record<string, unknown>) => linkButton(String(j.id).slice(0, 12), `/staff/builds/${String(j.id)}`, "ghost", "sm") },
      { header: "State", cell: (j: Record<string, unknown>) => badge(BUILD_TONE[String(j.state)] ?? "info", String(j.state).replace(/_/g, " ")) },
      { header: "Attempts", cell: (j: Record<string, unknown>) => html`${String(j.attempts ?? 0)} of ${String(j.max_attempts ?? 0)}` },
      { header: "Why it stopped", cell: (j: Record<string, unknown>) => j.stop_reason
          ? html`${String(j.stop_reason)}` : j.state_reason ? html`<span class="faint">${String(j.state_reason)}</span>` : html`<span class="faint">\u2014</span>` },
      { header: "Preview", cell: (j: Record<string, unknown>) => j.preview_url
          ? html`<a href="${String(j.preview_url)}" rel="noopener">Open the website</a>` : html`<span class="faint">none</span>` },
      { header: "Finished", cell: (j: Record<string, unknown>) => j.finished_at ? html`${formatDateTime(String(j.finished_at))}` : html`<span class="faint">running</span>` },
    ])}

  ${latestReport ? html`<h3 style="font-size:1rem;margin-top:1rem">What the runner reported</h3>
    <p class="faint">The runner's own account of the most recent build: each gate's finding, every repair cycle it attempted, and why it stopped.</p>
    <pre style="white-space:pre-wrap;max-height:28rem;overflow:auto">${latestReport}</pre>` : ""}
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

  // Offer a rejected artifact for import again.
  //
  // The archive is still in R2 and its scan verdict is still clean; what was wrong was the importer's reading of
  // it. Without this, every artifact the importer refused before a fix stayed refused for ever, and the only
  // recovery was asking the owner to upload the same bytes a second time. The service re-reads the scan status
  // rather than trusting the artifact's copy of it, so a retry can never bypass scanning.
  r.post(`${BASE}/:projectId/artifacts/:artifactId/retry-import`, async (ctx, p) => {
    requireStaff(ctx, "builds.configure");
    const r0 = await DL.retryImport(ctx.db, p.artifactId, { actorId: actorId(ctx), ip: ctx.ip ?? null });
    if (!r0.ok) throw new HttpError(409, `This artifact cannot be imported again: ${r0.why}`);
    return redirect(ctx, `${BASE}/${p.projectId}`);
  });

  // ── the project's design-lock state, as JSON ──────────────────────────────────────────────────────────────
  //
  // Read-only and staff-authenticated. Deliberately NOT named `.json`: in this codebase that suffix marks a
  // downloadable export (alongside .csv, .md, .pdf), which the audit inventory requires to be recorded as a
  // data egress. This is a live status read for the dashboard and for tests, so auditing every glance at it
  // would be noise. The runner's own signed channel carries the archive bytes; this carries nothing but state.
  // ── reject an artifact ─────────────────────────────────────────────────────────────────
  //
  // Approving is the decision that locks a design; this is the other half of it. Without it a staff member who
  // sees a wrong or broken artifact has nothing to press, and the project sits in `validating_artifact` looking
  // like something is still running. The reason is required, because "rejected" with no account of why is not a
  // decision anyone can act on.
  r.post(`${BASE}/:projectId/artifacts/:artifactId/reject`, async (ctx, p) => {
    requireStaff(ctx, "builds.configure");
    const form = await ctx.form();
    const reason = str(form, "reason").slice(0, 300);
    if (!reason) throw new HttpError(422, "Say why it is being rejected.");

    const artifact = await DL.getArtifact(ctx.db, p.artifactId);
    if (!artifact || artifact.project_id !== p.projectId) throw new HttpError(404, "No such artifact for this project.");

    await DL.recordVerdict(ctx.db, artifact.id, {
      status: "rejected",
      problems: [reason],
      actorId: actorId(ctx),
    });
    return redirect(ctx, `${BASE}/${p.projectId}`);
  });

  // ── start a backend job ──────────────────────────────────────────────────────────────
  //
  // Through `syncProjectBuild`, which is the platform's own queueing path: it applies the same eligibility rule
  // every build follows, snapshots the brief, seeds the requirements, and calls `applyDesignLock` so the job is
  // marked as a design-locked build rather than a website generation. Deliberately NOT a second code path that
  // inserts a build row directly — that would be a way to start a build the rules would have refused.
  //
  // `backfill` is the trigger the Owner already uses to start a build for a project that should have one.
  r.post(`${BASE}/:projectId/build`, async (ctx, p) => {
    requireStaff(ctx, "builds.configure");
    const projectId = p.projectId;

    const state = await DL.frontendState(ctx.db, projectId);
    if (!state.designLocked) throw new HttpError(409, "This project has no approved design baseline, so there is nothing to build a backend against.");

    const actor = actorId(ctx);
    const job = await syncProjectBuild(ctx.db, projectId, "backfill", { kind: "user", userId: actor });
    if (!job) {
      // Honest refusal with the actual reason, rather than a redirect that looks like success.
      const facts = await projectFacts(ctx.db, projectId);
      const decision = decideEligibility(facts);
      const settings = await getBuildSettings(ctx.db);
      const why = decision.verdict === "ineligible"
        ? decision.reasons.join("; ")
        : !settings.automation_enabled
          ? "automatic starts are switched off in the AI builds settings"
          : "the project is not yet eligible for a build";
      throw new HttpError(409, `No build was queued: ${why}.`);
    }

    // Starting a build spends the runner's time and the project's budget against a design someone approved, so it
    // is attributable like the approval was.
    await audit(ctx.db, {
      actorUserId: actor, actorKind: "user", action: "builds.backend_job_started",
      subjectType: "build_job", subjectId: job.id, organizationId: job.organization_id,
      details: { projectId, baselineId: state.activeBaselineId, state: job.state, trigger: "backfill" },
    });
    return redirect(ctx, `${BASE}/${projectId}`);
  });

  // Record the integration contract for this project's approved design.
  //
  // Validated by the service against the design that was actually measured, and every refusal comes back with its
  // reasons rather than being stored to fail inside a build later. A person writes this: the contract is what an
  // implementation is judged against, so the model doing the work must not be its author.
  r.post(`${BASE}/:projectId/contract`, async (ctx, p) => {
    requireStaff(ctx, "builds.configure");
    const form = await ctx.form();
    const text = str(form, "manifest").trim();
    if (!text) throw new HttpError(422, "Paste the contract as JSON.");
    if (text.length > 400_000) throw new HttpError(413, "That contract is larger than 400 KB; a contract names operations, it does not carry data.");

    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch (e) { throw new HttpError(422, `That is not valid JSON: ${(e as Error).message.slice(0, 200)}`); }

    const result = await DL.recordContract(ctx.db, p.projectId, parsed, {
      recordedBy: actorId(ctx), authoredBy: "staff", note: str(form, "note") || null, ip: ctx.ip ?? null,
    });
    if (!result.ok) throw new HttpError(422, `The contract was not recorded: ${result.problems.slice(0, 8).join("; ")}`);
    // The contract was the thing the build was waiting for, so recording one starts it -- the same step the
    // drafted path takes, through the same eligibility rule and capacity cap. A project whose design is approved
    // and whose contract has just arrived should not need a second button press; whether it was accepted or
    // declined is shown by the Backend development section on the page this redirects to.
    await startBackendBuild(ctx.db, p.projectId, { actor: { kind: "user", userId: actorId(ctx) } });
    return redirect(ctx, `${BASE}/${p.projectId}`);
  });

  r.get(`${BASE}/:projectId/state`, async (ctx, p) => {
    requireStaff(ctx, "builds.read");
    const [state, artifacts, baselines, contractState] = await Promise.all([
      DL.frontendState(ctx.db, p.projectId),
      DL.listArtifacts(ctx.db, p.projectId),
      DL.listBaselines(ctx.db, p.projectId),
      DL.activeContract(ctx.db, p.projectId),
    ]);
    const gate = await DL.designGenerationAllowed(ctx.db, p.projectId);
    return jsonResponse(ctx, 200, {
      projectId: p.projectId,
      ...state,
      designGenerationAllowed: gate.allowed,
      designGenerationReason: gate.reason,
      // sha256 and artifactId are here because a contract has to DECLARE the design it was written against, and
      // whoever writes one needs the two exact values to declare. They are not secrets: an archive's checksum and
      // the id of a design this staff user can already read on the page beside it.
      artifacts: artifacts.map((a) => ({ id: a.id, version: a.version, source: a.source, framework: a.framework, scanStatus: a.scan_status, status: a.status, sha256: a.sha256 })),
      baselines: baselines.map((b) => ({ id: b.id, version: b.version, status: b.status, fingerprint: b.fingerprint, artifactId: b.artifact_id, approvedAt: b.approved_at, approvedBy: b.approved_by })),
      contract: contractState
        ? {
          version: contractState.version, operations: contractState.operations,
          visualStates: contractState.visual_states, designFingerprint: contractState.design_fingerprint,
          recordedAt: contractState.created_at,
          // Provenance and open questions: an automated check reading this endpoint needs to know whether a
          // contract was drafted or written, and what it left unsettled.
          authoredBy: contractState.authored_by, authorModel: contractState.author_model,
          reviewFlags: safeArr(contractState.review_flags_json).length,
        }
        : null,
    });
  });
}

/** A JSON array column, parsed defensively: a malformed column must not take the page down. */
function safeArr<T = Record<string, unknown>>(json: string | null): T[] {
  try { const a = JSON.parse(json ?? "[]"); return Array.isArray(a) ? (a as T[]) : []; } catch { return []; }
}

/** A build's state, in the tone the workflow means it. */
const BUILD_TONE: Record<string, string> = {
  ready_for_review: "ok", approved: "ok", queued: "info", preparing: "info", building: "info", verifying: "info",
  failed: "danger", canceled: "muted", needs_information: "warn", budget_paused: "warn", paused: "warn",
  awaiting_intake: "muted", awaiting_payment: "muted",
};

function safeLen(json: string): number {
  try { const a = JSON.parse(json); return Array.isArray(a) ? a.length : 0; } catch { return 0; }
}
