// Model B's new job: make an approved frontend work, without changing how it looks.
//
// This is the whole architecture in one phase. The design arrives finished and frozen; the manifest says what
// has to become functional; Model B writes the backend and wires it up; and the result is re-measured against
// the baseline. Nothing here asks a model for an opinion about appearance, and the prompt says so repeatedly —
// not out of politeness, but because the previous architecture's failure mode was a model that kept improving
// a design nobody asked it to touch.
//
// The prompt is assembled from FACTS the pipeline measured: the routes that exist, the controls that already
// work, the ones that do not, the acceptance criteria written before the work, and the exact list of things
// that will fail the verification. A model told "build the backend" invents scope; a model given this list does
// the work in front of it.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DesignBaseline } from "./design-lock.ts";
import type { ImportReport } from "./import.ts";
import { describeImport } from "./import.ts";
import { completeness, describeContract, executionOrder } from "./integration-manifest.ts";
import type { IntegrationManifest, ManifestContract } from "./integration-manifest.ts";

export const INTEGRATION_PHASE = "integration" as const;

export interface IntegrationPromptInput {
  manifest: IntegrationManifest & ManifestContract;
  baseline: DesignBaseline;
  report: ImportReport;
  /** Where the built site is served from, relative to the repo root. */
  outputRoot: string;
  /** Project framework, for the runtime instructions. */
  framework: string;
}

const bullet = (s: string) => `  - ${s}`;

/**
 * What Model B is told.
 *
 * Deliberately ordered: the prohibition first, because it is the one thing that must survive a long session; the
 * work second; the evidence it will be judged on last, so the final thing in context is how it will be checked.
 */
export function integrationPrompt(i: IntegrationPromptInput): string {
  const { manifest: m, baseline: b, report: r } = i;
  const order = executionOrder(m) ?? m.operations;
  const gaps = completeness(m);

  const working = r.interactions.filter((x) => x.functional);
  const needing = r.interactions.filter((x) => x.needsBackend && !x.functional);
  const undetermined = r.interactions.filter((x) => x.undetermined);

  const lines: string[] = [];

  lines.push(`# Make this website work`);
  lines.push("");
  lines.push(`The frontend in this repository is FINISHED and APPROVED. A person designed it, reviewed it and signed it off; it is not a draft, a starting point or a suggestion. Your job is to build the backend it needs and connect it, and nothing else.`);
  lines.push("");

  lines.push(`## The design is locked`);
  lines.push("");
  lines.push(`Approved by ${b.approvedBy}. Design fingerprint \`${b.fingerprint.slice(0, 16)}…\`, measured across ${b.signatures.length} page views at ${[...new Set(b.signatures.map((s) => s.viewport))].join(", ")}.`);
  lines.push("");
  lines.push(`You must NOT:`);
  for (const s of [
    "change the visual hierarchy, or move sections around",
    "replace or re-crop hero imagery or any other asset",
    "change typography — families, sizes, weights or the type scale",
    "alter the colour palette, including adding a colour that is not already used",
    "redesign the navigation, or change how it behaves at any viewport",
    "replace an approved component with a different one, or with a library's version of it",
    "remove visual detail you think is unnecessary",
    "substitute a generic starter layout, or rebuild any page from scratch",
    "'tidy up', 'modernise' or 'improve' anything about how the site looks",
  ]) lines.push(bullet(s));
  lines.push("");
  lines.push(`You MAY edit any file, including frontend files, where that is what connecting real functionality requires — adding a submit handler, a loading state, a validation message, an aria attribute, a fetch call. The test is not which file you touched. It is whether the approved appearance still renders.`);
  lines.push("");
  lines.push(`If you believe a visible design change is genuinely necessary, do not make it. Write what you would change and why into \`.crestmont/design-exception-request.md\` and carry on with the rest. A person decides.`);
  lines.push("");

  lines.push(`## What already works — leave it alone`);
  lines.push("");
  lines.push(`${working.length} control(s) already behave correctly with no backend at all. They were tested by clicking them and watching the page react. Do not rewrite them, do not "improve" them, and do not route them through a server:`);
  for (const w of working.slice(0, 14)) lines.push(bullet(`\`${w.page}\` → \`${w.element}\` — ${w.evidence}`));
  if (working.length > 14) lines.push(bullet(`…and ${working.length - 14} more`));
  lines.push("");

  // The contract has always said how the data must be stored. The brief never passed it on, so the model chose:
  // the first Northgate run wrote a JSON file (which genuinely persists, and survived the restart check) and the
  // second reached for a native sqlite driver the sandbox cannot build. Both were reasonable guesses at something
  // the contract had already decided. Say it here, where the work starts, instead of only in a repair message
  // after a gate has failed.
  if (m.persistence) {
    const p9 = m.persistence;
    lines.push(`## How it must store things`);
    lines.push("");
    lines.push(p9.enforcement === "required"
      ? `The approved architecture uses **${p9.technology}**, and that is a requirement, not a preference. A JSON file, an in-memory array or a different database is a failed build even if every request returns the right answer — behaviour cannot tell them apart, and a file store loses writes the first time two people submit at once.`
      : `The approved architecture uses **${p9.technology}**. Any mechanism that genuinely persists is acceptable here, so use your judgement — but an in-memory array is not persistence.`);
    if (p9.technology === "sqlite") {
      lines.push("");
      lines.push(`Use \`node:sqlite\`, which is built into Node and needs no install. **The sandbox has no network and no compiler**, so a native driver such as \`better-sqlite3\` may not install at all; a dependency the sandbox cannot build is a failed build, not a detail.`);
    }
    if (p9.durable !== false) {
      lines.push("");
      lines.push(`Rows must survive the application restarting. This is checked by restarting it and reading them back.`);
    }
    if (p9.evidence?.length) {
      lines.push("");
      lines.push(`How a reader will tell it is really in use: ${p9.evidence.map((e) => `${e}`).join("; ")}.`);
    }
    lines.push("");
  }

  // The independent driver starts the application to check it. Nothing told the model that, and nothing said how,
  // so the second Northgate run wrote server/db.ts and server/server.ts, added no script, and the functional gate
  // reported "the project has no start script and no server file, so the application could not be started" -- 19
  // criteria unevaluated because nobody could run the thing. The contract already permits the script; say so.
  const startable = (m.projectConfig?.allowedNewScripts ?? []).find((n) => n === "start" || n === "api" || n === "serve");
  if (startable) {
    lines.push(`## It has to start`);
    lines.push("");
    lines.push(`Add a \`${startable}\` script to \`package.json\` that starts the API and serves the built site, and make sure it works. An independent driver -- not written by you and not editable by you -- runs \`npm run ${startable}\`, waits for the port, and exercises every endpoint the contract declares. If it cannot start the application, nothing about your work can be verified and the build fails on that alone, however good the code is.`);
    lines.push("");
    lines.push(`It must listen on the port in \`PORT\` when that is set. If you write TypeScript, the script must run what the build produces, not the sources.`);
    lines.push("");
  }

  lines.push(`## What you are building`);
  lines.push("");
  lines.push(`${needing.length} control(s) need a backend. ${order.length} operation(s) are planned, in this order:`);
  lines.push("");
  for (const [n, op] of order.entries()) {
    lines.push(`### ${n + 1}. ${op.id} — ${op.kind}`);
    lines.push(`On \`${op.page}\`, the element \`${op.element}\`.`);
    lines.push(`**Behaviour:** ${op.behaviour}`);
    if (op.dataModel?.length) {
      for (const d of op.dataModel) lines.push(`**Stores:** \`${d.table}\` (${d.fields.join(", ")})`);
    }
    lines.push(`**Done when:**`);
    for (const a of op.acceptance) lines.push(bullet(a));
    if (op.expectChange === "content") lines.push(`This operation is expected to change what the page renders once real data arrives. That is declared and allowed.`);
    else lines.push(`This operation must NOT change what the page renders.`);
    if (op.dependsOn?.length) lines.push(`Depends on: ${op.dependsOn.join(", ")}.`);
    lines.push("");
  }

  if (undetermined.length) {
    lines.push(`## Not your decision`);
    lines.push("");
    lines.push(`These elements may show live data or may be content the designer typed in. Nobody has decided, and you must not decide for them. Leave them exactly as they are and note them in your summary:`);
    for (const u of undetermined.slice(0, 10)) lines.push(bullet(`\`${u.page}\` → \`${u.element}\` (${u.kind ?? u.role})`));
    lines.push("");
  }

  lines.push(`## Rules about honesty`);
  lines.push("");
  for (const s of [
    "No endpoint may answer with success unless it really did the thing. A handler that returns 201 without writing a row is worse than no handler, because the business never learns the lead was lost.",
    "No mock, stub or placeholder may be left in place and reported as finished. If something cannot be completed, say so plainly in your summary.",
    "No payment may report success without a real, authorised test-mode transaction.",
    "Validate on the server. The browser's `required` attributes are a convenience for the visitor and absent entirely from a direct request.",
    "Handle failure. When a write fails, the visitor must be told it failed — never shown a confirmation.",
    "Do not invent prices, business policies, opening hours, or third-party service details. If you need one and it is not in this document, record it as a question instead.",
  ]) lines.push(bullet(s));
  lines.push("");

  if (gaps.blockers.length) {
    lines.push(`## Known blockers`);
    lines.push("");
    lines.push(`These were identified before you started. Do not work around them by inventing a value:`);
    for (const x of gaps.blockers) lines.push(bullet(`${x.code}${x.operationId ? ` [${x.operationId}]` : ""}: ${x.detail}`));
    lines.push("");
  }
  if (gaps.missing.length) {
    lines.push(`Recorded as missing: ${gaps.missing.map((x) => `${x.what} (${x.why})`).join("; ")}.`);
    lines.push("");
  }

  lines.push(`## The project`);
  lines.push("");
  lines.push(`A ${i.framework} project. The built site is served from \`${i.outputRoot || "the project root"}\`.`);
  lines.push(`Routes: ${r.routes.map((x) => `\`${x.page}\``).join(", ")}.`);
  if (m.runtime?.deploy) lines.push(`Deployment target: ${m.runtime.deploy}.`);
  if (m.apis?.length) {
    lines.push(`Endpoints the plan expects:`);
    for (const a of m.apis) lines.push(bullet(`\`${a.method} ${a.path}\`${a.auth ? ` (${a.auth})` : ""}${a.purpose ? ` — ${a.purpose}` : ""}`));
  }
  lines.push("");

  lines.push(`## How your work will be checked`);
  lines.push("");
  lines.push(`When you stop, the site is rebuilt and re-rendered at ${[...new Set(b.signatures.map((s) => s.viewport))].join(", ")}, and compared with the approved baseline. The comparison is on the design, not on pixels, so real data appearing is fine. It FAILS if any of these moved:`);
  for (const s of [
    "the layout skeleton — which elements exist, nested how, in what order",
    "the palette actually painted, including any colour you add",
    "the fonts and the rendered type scale",
    "the page frame — each landmark's horizontal position and width, their vertical order, and the spacing between them",
    "any page of the approved design that stops rendering, or any page that appears that was not approved",
  ]) lines.push(bullet(s));
  lines.push("");
  lines.push(`The acceptance criteria above are then run against the real application. Both have to pass. A site that works but looks different fails. A site that looks right but does not work fails.`);
  lines.push("");
  lines.push(`Write a short summary of what you did, what you could not do, and any question you had to leave open, to \`.crestmont/integration-summary.md\`.`);

  return lines.join("\n");
}

/** A compact digest of the import, for the session's memory. */
export function integrationMemory(r: ImportReport, b: DesignBaseline): string {
  return [
    `The frontend is approved and design-locked (fingerprint ${b.fingerprint.slice(0, 12)}…, approved by ${b.approvedBy}).`,
    `Do not change the visual design. Build and connect the backend only.`,
    describeImport(r).split("\n").slice(0, 4).join("\n"),
  ].join("\n");
}

export interface IntegrationOutcome {
  /** Did Model B leave a summary, as asked? */
  summary: string | null;
  /** A design exception it asked for rather than took. */
  exceptionRequest: string | null;
  /** Files it changed, from the workspace's own git state when available. */
  changed: string[];
}

/** Read what Model B left behind in the workspace. */
export function readIntegrationOutcome(repo: string): IntegrationOutcome {
  const read = (p: string): string | null => {
    const f = path.join(repo, p);
    try { return existsSync(f) ? readFileSync(f, "utf8").slice(0, 20_000) : null; } catch { return null; }
  };
  return {
    summary: read(".crestmont/integration-summary.md"),
    exceptionRequest: read(".crestmont/design-exception-request.md"),
    changed: [],
  };
}

/** The contract in words, for the build record, alongside the prompt that was actually sent. */
export function describeIntegration(i: IntegrationPromptInput): string {
  return [
    describeContract(i.manifest),
    `prompt: ${integrationPrompt(i).length} characters, ${i.manifest.operations.length} operation(s)`,
  ].join("\n");
}
