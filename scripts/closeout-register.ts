// Closeout register for the 104 findings of the 2026-10-29 master audit (docs/closeout/AUDIT-2026-10-29.md).
// The JSON file is the source of truth; this script validates it and renders docs/closeout/CRESTMONT-104-CLOSEOUT.md.
//   node --no-warnings scripts/closeout-register.ts           # write the markdown
//   node --no-warnings scripts/closeout-register.ts --check   # exit 1 if the markdown is out of date or the JSON is invalid
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DISPOSITIONS = [
  "CLOSED — VERIFIED",
  "ENGINEERING COMPLETE — STAGING VERIFICATION PENDING",
  "ENGINEERING COMPLETE — EXTERNAL VERIFICATION PENDING",
  "BLOCKED — HUMAN ACTION",
  "BLOCKED — PROVIDER ACCESS",
  "OPEN — ENGINEERING",
  "NOT APPLICABLE — EVIDENCE BACKED",
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export interface Finding {
  id: string; originalPriority: string; system: string; originalDescription: string; originalStatus: string;
  originalEvidence: string; requiredFix: string; owner: string; dependencies: string; effort: string; acceptanceTest: string;
  stream: string; currentPriority: string; priorityChangeReason: string | null; rootCause: string | null;
  disposition: Disposition; branch: string | null; pr: number | null; commit: string | null; tests: string[];
  deployment: string; stagingVerification: string | null; externalRequirements: string | null; unblockAction: string | null;
  evidence: string | null; notes: string | null;
}
export interface Register { source: string; auditCommit: string; findings: Finding[]; supplemental?: Finding[] }

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const REGISTER_PATH = ROOT + "docs/closeout/crestmont-104-register.json";
export const MARKDOWN_PATH = ROOT + "docs/closeout/CRESTMONT-104-CLOSEOUT.md";
export const AUDIT_PATH = ROOT + "docs/closeout/AUDIT-2026-10-29.md";

export function loadRegister(): Register {
  return JSON.parse(readFileSync(REGISTER_PATH, "utf8")) as Register;
}

/** Every rule the register must satisfy. Returns human-readable problems (empty = valid). */
export function validate(reg: Register, auditMarkdown: string): string[] {
  const problems: string[] = [];
  const ids = reg.findings.map((f) => f.id);
  if (reg.findings.length !== 104) problems.push(`expected 104 original findings, found ${reg.findings.length}`);
  for (let n = 1; n <= 104; n++) {
    const id = `CREST-GAP-${String(n).padStart(3, "0")}`;
    if (!ids.includes(id)) problems.push(`missing ${id}`);
  }
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) problems.push(`duplicate ids: ${[...new Set(dup)].join(", ")}`);
  for (const f of reg.findings) {
    if (!/^CREST-GAP-\d{3}$/.test(f.id)) problems.push(`${f.id}: not an original id`);
    if (!(DISPOSITIONS as readonly string[]).includes(f.disposition)) problems.push(`${f.id}: unknown disposition "${f.disposition}"`);
    if (!auditMarkdown.includes(`| ${f.id} | ${f.system} | ${f.originalDescription} | ${f.originalPriority} |`)) problems.push(`${f.id}: original description/priority differs from the audit document`);
    if (f.currentPriority !== f.originalPriority && !f.priorityChangeReason) problems.push(`${f.id}: priority changed without a documented reason`);
    const engineered = f.disposition.startsWith("ENGINEERING COMPLETE") || f.disposition === "CLOSED — VERIFIED";
    if (engineered && (!f.commit || !f.tests.length || !f.evidence)) problems.push(`${f.id}: ${f.disposition} needs commit, tests and evidence`);
    if (f.disposition === "CLOSED — VERIFIED" && !f.stagingVerification) problems.push(`${f.id}: CLOSED — VERIFIED needs live staging verification evidence`);
    if (f.disposition === "ENGINEERING COMPLETE — EXTERNAL VERIFICATION PENDING" && !f.externalRequirements) problems.push(`${f.id}: external verification pending needs the external requirement`);
    if (f.disposition.startsWith("BLOCKED") && !f.unblockAction) problems.push(`${f.id}: blocked without a concrete unblock action`);
    if (f.disposition === "NOT APPLICABLE — EVIDENCE BACKED" && !f.evidence) problems.push(`${f.id}: not applicable without evidence`);
  }
  for (const s of reg.supplemental ?? []) if (!/^CREST-NEW-\d{3}$/.test(s.id)) problems.push(`${s.id}: supplemental findings use CREST-NEW-nnn`);
  return problems;
}

export function counters(reg: Register) {
  const c = Object.fromEntries(DISPOSITIONS.map((d) => [d, 0])) as Record<Disposition, number>;
  for (const f of reg.findings) c[f.disposition]++;
  return {
    byDisposition: c,
    engineeringComplete: reg.findings.filter((f) => f.disposition.startsWith("ENGINEERING COMPLETE") || f.disposition === "CLOSED — VERIFIED").length,
    tested: reg.findings.filter((f) => f.tests.length > 0).length,
    stagingCertified: reg.findings.filter((f) => f.disposition === "CLOSED — VERIFIED").length,
    externalPending: reg.findings.filter((f) => f.disposition === "ENGINEERING COMPLETE — EXTERNAL VERIFICATION PENDING" || f.disposition.startsWith("BLOCKED")).length,
  };
}

const cell = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " "));

export function render(reg: Register): string {
  const k = counters(reg);
  const lines = [
    "# CRESTMONT — 104-finding closeout register",
    "",
    `Generated from \`docs/closeout/crestmont-104-register.json\` by \`scripts/closeout-register.ts\`. Do not edit by hand. Source audit: \`${reg.source}\` (main @ ${reg.auditCommit}).`,
    "",
    "## Counters",
    "",
    "| Measure | Count |",
    "| --- | --- |",
    `| Original findings | ${reg.findings.length} |`,
    `| Engineering complete (incl. closed) | ${k.engineeringComplete} |`,
    `| With automated tests | ${k.tested} |`,
    `| Staging certified (CLOSED — VERIFIED) | ${k.stagingCertified} |`,
    `| Awaiting external or human action | ${k.externalPending} |`,
    ...DISPOSITIONS.map((d) => `| ${d} | ${k.byDisposition[d]} |`),
    `| Supplemental findings (CREST-NEW) | ${(reg.supplemental ?? []).length} |`,
    "",
    "## Findings",
    "",
    "| ID | Priority | Stream | Disposition | PR | Commit | Tests | Staging verification | Unblock action / notes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...[...reg.findings, ...(reg.supplemental ?? [])].map((f) => `| ${f.id} | ${f.currentPriority} | ${f.stream} | ${f.disposition} | ${f.pr ? `#${f.pr}` : "—"} | ${f.commit ? f.commit.slice(0, 7) : "—"} | ${cell(f.tests.join(", "))} | ${cell(f.stagingVerification)} | ${cell(f.unblockAction ?? f.notes)} |`),
    "",
  ];
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const reg = loadRegister();
  const problems = validate(reg, readFileSync(AUDIT_PATH, "utf8"));
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  const md = render(reg);
  if (process.argv.includes("--check")) {
    if (readFileSync(MARKDOWN_PATH, "utf8") !== md) { console.error("CRESTMONT-104-CLOSEOUT.md is out of date: run node --no-warnings scripts/closeout-register.ts"); process.exit(1); }
  } else writeFileSync(MARKDOWN_PATH, md);
  console.log(JSON.stringify(counters(reg)));
}
