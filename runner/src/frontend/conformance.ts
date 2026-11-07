// Did the implementation follow the approved contract, or merely behave correctly?
//
// THE DEFECT THIS EXISTS FOR. The first autonomous run produced a quote form that worked perfectly: a real
// server, real validation, a real 422, a real record, and a visitor who was told the truth when a write failed.
// Ten behavioural checks passed. It stored its rows in a JSON file, while the manifest named a `quote_requests`
// table. Nothing noticed, because behaviour was the only thing anything looked at.
//
// Working is not the same as conforming. A business that was promised a database and got a JSON file has been
// given something that will fall over the first time two people submit at once, and it looks identical from
// the outside until that happens.
//
// WHAT THIS CAN AND CANNOT PROVE. These are checks on the SOURCE plus whatever runtime evidence the verifier
// collected. Static analysis can show that `CREATE TABLE quote_requests` exists and that `node:sqlite` is
// imported; it cannot prove the table is the one the handler writes to. So every finding says what it is based
// on, and `basis` is "source" or "runtime" — a reader can tell a proof from an indication.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { ApiContract, IntegrationManifest, ManifestContract, PersistenceContract } from "./integration-manifest.ts";

export type Severity = "violation" | "warning";

export interface ConformanceFinding {
  severity: Severity;
  /** The contract area: persistence, schema, api, auth, integrations, config, secrets, security. */
  area: string;
  code: string;
  /** What is wrong, in the words a person would use. */
  detail: string;
  /** What Model B should do about it. This is handed back verbatim as repair instructions. */
  repair: string;
  /** Whether this was decided from the source or from a real request. */
  basis: "source" | "runtime";
  file?: string;
}

export interface RuntimeEvidence {
  /** Endpoints that were really called during verification, with the statuses they really returned. */
  calls?: { method: string; path: string; status: number }[];
  /** Origins the application really contacted. */
  origins?: string[];
  /** True when records really survived a restart of the application. */
  survivedRestart?: boolean | null;
}

export interface ConformanceReport {
  ok: boolean;
  findings: ConformanceFinding[];
  /** Everything checked, so a pass says what it covered rather than only that nothing was found. */
  checked: string[];
}

/** Source files worth reading. Build output and dependencies are not the implementation. */
const SKIP = new Set(["node_modules", "dist", "build", ".git", ".crestmont", ".next", "coverage", ".wrangler", ".vite"]);
const SOURCE = /\.(m?[jt]sx?|sql|json|toml|ya?ml)$/i;

function sources(repo: string, dir = repo, depth = 0, out: { path: string; text: string }[] = []): { path: string; text: string }[] {
  if (depth > 6 || out.length > 800) return out;
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (SKIP.has(n)) continue;
    const p = path.join(dir, n);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { sources(repo, p, depth + 1, out); continue; }
    if (!SOURCE.test(n) || st.size > 1_500_000) continue;
    try { out.push({ path: path.relative(repo, p).split(path.sep).join("/"), text: readFileSync(p, "utf8") }); } catch { /* unreadable */ }
  }
  return out;
}

/** How each storage technology shows itself in source. Deliberately generous: several spellings each. */
const TECH_EVIDENCE: Record<PersistenceContract["technology"], RegExp[]> = {
  sqlite: [/node:sqlite/, /\bDatabaseSync\b/, /better-sqlite3/, /\bsqlite3\b/],
  d1: [/\bD1Database\b/, /env\.DB\b/, /\.prepare\([`'"]/, /d1_databases/],
  postgres: [/\bpg\b["']?\s*:/, /from ["']pg["']/, /postgres:\/\//, /\bPool\b.*pg/],
  mysql: [/mysql2?/, /mysql:\/\//],
  kv: [/\bKVNamespace\b/, /env\.KV\b/],
  file: [/writeFileSync\(/, /fs\.promises\.writeFile/],
};

/**
 * Storage that is NOT a database, used where one was required.
 *
 * Matching the path inside the write call is not enough: the first version looked for `writeFileSync(... .json`
 * and missed the real case entirely, because the model had put the path in a constant
 * (`writeFileSync(DATA_FILE, JSON.stringify(rows))`). What identifies a file store is the COMBINATION of
 * serialising to JSON and writing a file in the same module, so that is what is looked for.
 */
export function fileStoreIn(text: string): string | null {
  // Built with RegExp rather than written as literals. A regex literal whose character class contains a
  // backtick confuses the type stripper this project relies on, and the symptom is silent: the expression
  // evaluates to false and the check simply never fires, so the implementation looks conforming when it is not.
  const has = (pattern: string) => new RegExp(pattern).test(text);
  const writes = has("writeFile(?:Sync)?\\s*\\(") || has("fs\\.promises\\.writeFile");
  if (!writes) return null;
  const serialises = has("JSON\\.stringify\\s*\\(");
  const jsonPath = has("[\"'" + String.fromCharCode(96) + "][^\"'" + String.fromCharCode(96) + "\\n]*\\.json[\"'" + String.fromCharCode(96) + "]");
  if (serialises && jsonPath) return "it serialises records with JSON.stringify and writes them to a .json file";
  if (serialises) return "it serialises records with JSON.stringify and writes them to a file";
  if (jsonPath) return "it writes records to a .json file";
  return null;
}


/**
 * Packages whose install step compiles a binary. Not exhaustive, and it does not need to be: `binding.gyp` in
 * an installed package is the general test, and this list catches the common ones before anything is installed.
 */
const KNOWN_NATIVE = new Set([
  "better-sqlite3", "sqlite3", "bcrypt", "canvas", "sharp", "node-sass", "grpc", "libxmljs",
  "node-expat", "zeromq", "serialport", "usb", "robotjs", "sleep", "re2", "node-pty",
]);

const CREATE_TABLE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)[`"']?\s*\(([\s\S]*?)\)\s*(?:;|$)/gi;

/** Tables the implementation actually defines, with the columns each one declares. */
export function declaredTables(files: { path: string; text: string }[]): Map<string, { columns: Set<string>; file: string }> {
  const out = new Map<string, { columns: Set<string>; file: string }>();
  for (const f of files) {
    for (const m of f.text.matchAll(CREATE_TABLE)) {
      const name = m[1].toLowerCase();
      const columns = new Set<string>();
      for (const line of m[2].split(",")) {
        const col = /^\s*[`"']?(\w+)[`"']?\s+\w/.exec(line);
        if (col && !/^(primary|unique|foreign|check|constraint|key|index)$/i.test(col[1])) columns.add(col[1].toLowerCase());
      }
      const prev = out.get(name);
      if (prev) for (const c of columns) prev.columns.add(c);
      else out.set(name, { columns, file: f.path });
    }
  }
  return out;
}

/**
 * Check an implementation against its contract.
 *
 * `baselinePackage` is the package.json of the APPROVED frontend, before any integration work, so that a
 * changed script or an added dependency can be seen as a change rather than assumed to have always been there.
 */
export function checkConformance(o: {
  repo: string;
  manifest: IntegrationManifest & ManifestContract;
  baselinePackage?: Record<string, unknown> | null;
  runtime?: RuntimeEvidence;
}): ConformanceReport {
  const { manifest: m } = o;
  const findings: ConformanceFinding[] = [];
  const checked: string[] = [];
  const files = sources(o.repo);
  const allText = files.map((f) => f.text).join("\n");

  const violation = (area: string, code: string, detail: string, repair: string, basis: "source" | "runtime" = "source", file?: string) =>
    findings.push({ severity: "violation", area, code, detail, repair, basis, file });
  const warn = (area: string, code: string, detail: string, repair: string, basis: "source" | "runtime" = "source", file?: string) =>
    findings.push({ severity: "warning", area, code, detail, repair, basis, file });

  // ── persistence technology ────────────────────────────────────────────────────────────────────────────────
  if (m.persistence) {
    const p = m.persistence;
    checked.push(`persistence technology (${p.technology}, ${p.enforcement})`);
    if (p.enforcement === "required") {
      const patterns = [...(TECH_EVIDENCE[p.technology] ?? []), ...(p.evidence ?? []).map((e) => new RegExp(e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))];
      const found = patterns.some((re) => re.test(allText));
      if (!found) {
        violation("persistence", "wrong-persistence-technology",
          `The contract requires ${p.technology}, and nothing in the source uses it.`,
          `Store the data in ${p.technology}, as the contract requires. Do not use a file, an in-memory array or another database. If ${p.technology} genuinely cannot be used here, stop and say why instead of substituting something else.`);
      }
      // The specific substitution the first run made.
      for (const f of files) {
        if (p.technology === "file") break;
        // Built with RegExp for the same reason as `fileStoreIn`: a literal here was corrupted once and the
        // symptom was silent — the loop simply never matched, so a file store sailed through as conforming.
        if (!new RegExp("\\b(store|save|persist|insert|record|row)\\b", "i").test(f.text)) continue;
        const how = fileStoreIn(f.text);
        if (how) {
          violation("persistence", "file-substituted-for-database",
            `${f.path} persists records to a file: ${how}. The contract requires ${p.technology}. Behaviour alone cannot tell these apart, which is exactly why this is checked — a JSON file loses writes the first time two people submit at once.`,
            `Replace the file store in ${f.path} with ${p.technology}. Keep the same request and response shapes, the same validation and the same error handling — only the storage changes.`,
            "source", f.path);
          break;
        }
      }
    }
    if (p.durable !== false && o.runtime?.survivedRestart === false) {
      violation("persistence", "not-durable",
        "Records did not survive a restart of the application, so nothing is really being persisted.",
        "Write records to the contract's storage so they outlive the process. An in-memory array is not persistence.",
        "runtime");
    }
  }

  // ── the verification seed, which must not be a way in ────────────────────────────────────────────────────
  //
  // A build that declares visual states is verified signed in, so the application creates the accounts the runner
  // asks for. That path exists for the gate and for nothing else: if it runs without the environment variable, the
  // finished site creates accounts nobody asked for, with known passwords, and that is a hole rather than a detail.
  if (m.visualStates?.length) {
    checked.push(`${m.visualStates.length} seeded visual state(s)`);
    const mentionsSeed = files.filter((f) => /CRESTMONT_SEED/.test(f.text));
    if (!mentionsSeed.length) {
      violation("verification", "seed-not-implemented",
        `The contract asks for ${m.visualStates.length} page(s) to be checked signed in, and nothing in the source reads CRESTMONT_SEED, so no account can be created and the design cannot be compared.`,
        `Read the JSON file named by CRESTMONT_SEED on start-up and create exactly the accounts it lists, through the same code path a real registration uses.`);
    }
    for (const f of mentionsSeed) {
      // The read has to be conditional on the variable. A file that names it and then seeds regardless is worse
      // than one that never heard of it, because it looks deliberate.
      const guarded = /if\s*\([^)]*CRESTMONT_SEED/.test(f.text)
        || /CRESTMONT_SEED[^;]{0,80}\?\?/.test(f.text)
        || /const\s+\w+\s*=\s*process\.env\.CRESTMONT_SEED[\s\S]{0,200}?if\s*\(\s*\w+\s*\)/.test(f.text);
      if (!guarded) {
        violation("verification", "seed-not-gated",
          `${f.path} reads CRESTMONT_SEED but does not visibly make the seeding conditional on it. A seeding path that runs unasked creates accounts with known passwords in the finished site.`,
          `Guard it: read the variable, and when it is unset do nothing at all — no accounts, no rows.`,
          "source", f.path);
      }
    }
  }

  // ── tables and fields ─────────────────────────────────────────────────────────────────────────────────────
  if (m.dataModels?.length) {
    checked.push(`${m.dataModels.length} declared table(s)`);
    const tables = declaredTables(files);
    for (const model of m.dataModels) {
      const got = tables.get(model.table.toLowerCase());
      if (!got) {
        // A table may be created by an ORM rather than by SQL. Say which it is rather than guessing.
        const mentioned = new RegExp(`\\b${model.table.replace(/[^\w]/g, "")}\\b`, "i").test(allText);
        violation("schema", "table-not-defined",
          mentioned
            ? `The contract requires a table \`${model.table}\`. The name appears in the source, but no CREATE TABLE defines it, so there is no schema for it.`
            : `The contract requires a table \`${model.table}\` and nothing in the source defines or mentions it.`,
          `Define \`${model.table}\` with the fields the contract names (${model.fields.join(", ")})${m.persistence ? ` in ${m.persistence.technology}` : ""}${m.persistence?.technology === "sqlite" ? " (node:sqlite is built in, which matters because the sandbox has no network)" : ""}.`);
        continue;
      }
      const missing = model.fields.filter((f) => !got.columns.has(f.toLowerCase()));
      if (missing.length) {
        violation("schema", "fields-missing",
          `\`${model.table}\` is defined in ${got.file} but is missing the field(s) the contract requires: ${missing.join(", ")}.`,
          `Add ${missing.join(", ")} to \`${model.table}\`. The contract names these fields because something downstream reads them.`,
          "source", got.file);
      }
    }
  }

  // ── API behaviour ─────────────────────────────────────────────────────────────────────────────────────────
  if (m.apis?.length) {
    checked.push(`${m.apis.length} declared endpoint(s)`);
    const calls = o.runtime?.calls ?? [];
    for (const api of m.apis as ApiContract[]) {
      const inSource = new RegExp(`["'\`]${api.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(allText);
      const observed = calls.filter((c) => c.path === api.path && c.method.toUpperCase() === api.method.toUpperCase());

      if (!inSource && observed.length === 0) {
        violation("api", "endpoint-missing",
          `The contract requires \`${api.method} ${api.path}\`${api.purpose ? ` (${api.purpose})` : ""} and it is neither in the source nor was it ever called.`,
          `Implement \`${api.method} ${api.path}\`${api.purpose ? ` — ${api.purpose}` : ""} and make the frontend use it.`);
        continue;
      }
      if (api.success && observed.length && !observed.some((c) => c.status === api.success)) {
        violation("api", "wrong-success-status",
          `\`${api.method} ${api.path}\` must answer ${api.success} on success; the statuses actually seen were ${[...new Set(observed.map((c) => c.status))].join(", ")}.`,
          `Return ${api.success} from \`${api.method} ${api.path}\` when the request succeeds.`,
          "runtime");
      }
      if (api.invalid && observed.length && !observed.some((c) => c.status === api.invalid)) {
        warn("api", "invalid-status-unproven",
          `\`${api.method} ${api.path}\` should answer ${api.invalid} to an invalid request; no such response was observed, so the rule is unproven rather than broken.`,
          `Make sure an invalid request to \`${api.path}\` is refused with ${api.invalid}, and that the verification exercises it.`,
          "runtime");
      }
    }
  }

  // ── authentication and authorization ──────────────────────────────────────────────────────────────────────
  if (m.auth?.required) {
    checked.push("authentication");
    const hasAuth = /\b(session|cookie|jwt|bearer|authorize|authenticate|requireUser|requireAuth|passport|argon2|bcrypt|scrypt)\b/i.test(allText);
    if (!hasAuth) {
      violation("auth", "no-authentication",
        `The contract requires authentication${m.auth.roles?.length ? ` for ${m.auth.roles.join(", ")}` : ""} and nothing in the source authenticates anyone.`,
        `Implement authentication as the contract describes${m.auth.provider ? `, using ${m.auth.provider}` : ""}. Protected endpoints must refuse an unauthenticated request.`);
    }
    for (const api of (m.apis ?? []) as ApiContract[]) {
      if (!api.unauthenticated) continue;
      const seen = (o.runtime?.calls ?? []).filter((c) => c.path === api.path);
      if (seen.length && !seen.some((c) => c.status === api.unauthenticated)) {
        violation("auth", "endpoint-not-protected",
          `\`${api.path}\` must answer ${api.unauthenticated} without authentication; it never did.`,
          `Refuse unauthenticated requests to \`${api.path}\` with ${api.unauthenticated}.`,
          "runtime");
      }
    }
  }

  // ── integrations ──────────────────────────────────────────────────────────────────────────────────────────
  if (m.externalIntegrations?.length || o.runtime?.origins?.length) {
    checked.push("external integrations");
    const approved = new Set((m.externalIntegrations ?? []).filter((i) => i.approved).map((i) => (i.origin ?? "").replace(/\/+$/, "")).filter(Boolean));
    for (const origin of o.runtime?.origins ?? []) {
      if (!approved.has(origin.replace(/\/+$/, ""))) {
        violation("integrations", "unapproved-origin",
          `The application contacted ${origin}, which no approved integration in the contract names.`,
          `Remove the call to ${origin}, or have it added to the contract as an approved integration first. A third-party service is not the AI's to choose.`,
          "runtime");
      }
    }
    for (const i of (m.externalIntegrations ?? []).filter((x) => !x.approved)) {
      if (i.origin && new RegExp(i.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(allText)) {
        violation("integrations", "unapproved-integration-used",
          `${i.name} is in the contract as NOT approved, and the source calls it.`,
          `Remove the ${i.name} integration until it is approved.`);
      }
    }
  }

  // ── project configuration ─────────────────────────────────────────────────────────────────────────────────
  //
  // The approved frontend's package.json is part of what was approved. A command that worked must keep working.
  const pkgPath = path.join(o.repo, "package.json");
  if (existsSync(pkgPath)) {
    checked.push("project configuration");
    let pkg: Record<string, unknown> = {};
    try { pkg = JSON.parse(readFileSync(pkgPath, "utf8")); } catch { /* reported below */ }
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const before = (o.baselinePackage?.scripts ?? {}) as Record<string, string>;
    const rules = m.projectConfig?.scripts ?? {};

    for (const [name, rule] of Object.entries(rules)) {
      const now = scripts[name];
      const was = before[name];
      if (rule === "preserve") {
        if (was !== undefined && now !== was) {
          violation("config", "script-replaced",
            `The \`${name}\` script was \`${was}\` in the approved project and is now \`${now ?? "(removed)"}\`. The contract requires it to be preserved.`,
            `Restore \`${name}\` to \`${was}\`. If the integration needs a different command, ADD a new script (for example \`start\` or \`serve\`) and leave \`${name}\` alone.`,
            "source", "package.json");
        }
      } else if (now !== rule) {
        violation("config", "script-wrong",
          `The contract requires \`${name}\` to be \`${rule}\`; it is \`${now ?? "(missing)"}\`.`,
          `Set the \`${name}\` script to \`${rule}\`.`, "source", "package.json");
      }
    }

    // Scripts and dependencies that appeared without the contract allowing them.
    if (o.baselinePackage) {
      const allowedScripts = new Set(m.projectConfig?.allowedNewScripts ?? []);
      for (const name of Object.keys(scripts)) {
        if (before[name] === undefined && !allowedScripts.has(name)) {
          warn("config", "script-added",
            `A \`${name}\` script was added that the contract does not mention.`,
            `Either keep \`${name}\` and have it recorded in the contract, or remove it.`, "source", "package.json");
        }
      }
      const beforeDeps = { ...(o.baselinePackage.dependencies as object ?? {}), ...(o.baselinePackage.devDependencies as object ?? {}) } as Record<string, string>;
      const nowDeps = { ...(pkg.dependencies as object ?? {}), ...(pkg.devDependencies as object ?? {}) } as Record<string, string>;
      const allowed = new Set(m.projectConfig?.allowedDependencies ?? []);
      for (const name of Object.keys(nowDeps)) {
        if (beforeDeps[name] === undefined && !allowed.has(name)) {
          warn("config", "dependency-added",
            `\`${name}\` was added to the project. The contract does not list it among the dependencies the integration may add.`,
            `Either use something the contract already allows (${[...allowed].join(", ") || "nothing is listed"}), or have \`${name}\` added to the contract's allowed dependencies with a reason.`,
            "source", "package.json");
        }
        if (beforeDeps[name] !== undefined && nowDeps[name] !== beforeDeps[name]) {
          violation("config", "dependency-version-changed",
            `\`${name}\` was pinned at ${beforeDeps[name]} in the approved project and is now ${nowDeps[name]}. Changing an approved dependency's version can change how the site renders.`,
            `Restore \`${name}\` to ${beforeDeps[name]}.`, "source", "package.json");
        }
      }
    }
  }

  // ── dependencies the sandbox cannot build ─────────────────────────────────────────────────────────────────
  //
  // The build sandbox installs with `--ignore-scripts`, deliberately: an install script is arbitrary code
  // execution on an uploaded package. A dependency with a native addon needs exactly that script to compile its
  // binary, so adding one produces code that passes every SOURCE check and then cannot start.
  //
  // This is not hypothetical. Asked to move from a JSON file to sqlite, a model reached for `better-sqlite3`
  // (native) when `node:sqlite` is built into the runtime and needs no build at all. Conformance passed, the
  // design held, and the application would not boot.
  if (existsSync(pkgPath)) {
    checked.push("native dependencies");
    let pkg: Record<string, unknown> = {};
    try { pkg = JSON.parse(readFileSync(pkgPath, "utf8")); } catch { /* reported above */ }
    const deps = Object.keys({ ...(pkg.dependencies as object ?? {}), ...(pkg.devDependencies as object ?? {}) });
    const baseDeps = new Set(Object.keys({ ...(o.baselinePackage?.dependencies as object ?? {}), ...(o.baselinePackage?.devDependencies as object ?? {}) }));
    for (const name of deps) {
      if (baseDeps.has(name)) continue;      // the approved project already depended on it
      const native = KNOWN_NATIVE.has(name) || existsSync(path.join(o.repo, "node_modules", name, "binding.gyp"));
      if (!native) continue;
      violation("config", "native-dependency",
        `\`${name}\` is a native addon: it compiles a binary in an install script. The build sandbox installs with --ignore-scripts, so that binary is never built and the application fails to start with "Could not locate the bindings file".`,
        `Use something that needs no native build. For SQLite that is \`node:sqlite\`, which is part of the runtime (\`import { DatabaseSync } from "node:sqlite"\`) and needs no dependency at all. Remove \`${name}\`.`,
        "source", "package.json");
    }
  }

  // ── secrets and environment ───────────────────────────────────────────────────────────────────────────────
  if (m.secrets?.length) {
    checked.push(`${m.secrets.length} declared secret(s)`);
    for (const s of m.secrets) {
      const read = new RegExp(`(process\\.env|env)[.\\[]\\s*["'\`]?${s.name}\\b`).test(allText);
      if (s.provided && !read) {
        warn("secrets", "secret-unused",
          `\`${s.name}\` is declared as available and nothing reads it.`,
          `Read \`${s.name}\` from the environment where the contract says it is needed (${s.purpose}), or have it removed from the contract.`);
      }
      // A secret's VALUE in the source is the serious case.
      const assigned = new RegExp(`${s.name}\\s*[=:]\\s*["'\`][^"'\`\\n]{12,}`).test(allText);
      if (assigned) {
        violation("secrets", "secret-hardcoded",
          `A literal value for \`${s.name}\` appears in the source. Secrets are read from the environment, never committed.`,
          `Remove the literal and read \`${s.name}\` from the environment.`);
      }
    }
  }

  // ── named security controls ───────────────────────────────────────────────────────────────────────────────
  if (m.securityControls?.length) {
    checked.push(`${m.securityControls.length} security control(s)`);
    for (const c of m.securityControls) {
      if (!c.evidence?.length) continue;
      const present = c.evidence.some((e) => new RegExp(e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(allText));
      if (!present) {
        violation("security", "control-missing",
          `The contract requires: ${c.requirement}. Nothing in the source shows it (looked for ${c.evidence.join(", ")}).`,
          `Implement it: ${c.requirement}.`);
      }
    }
  }

  return { ok: !findings.some((f) => f.severity === "violation"), findings, checked };
}

/**
 * The feedback Model B gets when its implementation does not conform.
 *
 * Written as instructions, not as a report. Each one says what to change and what to leave alone, because the
 * failure mode being guarded against is a model that reads "the persistence is wrong" and rewrites the form.
 */
export function repairBrief(r: ConformanceReport, o: { attempt: number; maxAttempts: number }): string {
  const violations = r.findings.filter((f) => f.severity === "violation");
  const warnings = r.findings.filter((f) => f.severity === "warning");
  const lines: string[] = [];

  lines.push(`# The implementation works, but it does not match the approved contract`);
  lines.push("");
  lines.push(`Repair ${o.attempt} of ${o.maxAttempts}. ${violations.length} thing(s) must change.`);
  lines.push("");
  lines.push(`**This is not a request to redesign anything.** The frontend is approved and locked, and the behaviour you built is correct — the tests passed. What is wrong is HOW it was built, measured against what was agreed before the work started. Change only what is listed here.`);
  lines.push("");

  for (const [n, f] of violations.entries()) {
    lines.push(`## ${n + 1}. ${f.code}${f.file ? ` — \`${f.file}\`` : ""}`);
    lines.push(`${f.detail}`);
    lines.push("");
    lines.push(`**Do this:** ${f.repair}`);
    lines.push("");
  }

  if (warnings.length) {
    lines.push(`## Also worth fixing, but not blocking`);
    for (const f of warnings) lines.push(`- ${f.code}: ${f.detail} — ${f.repair}`);
    lines.push("");
  }

  lines.push(`## Do not`);
  for (const s of [
    "change any visual design, markup structure, class name or style",
    "rewrite the parts that already pass — keep the request and response shapes, the validation and the error handling exactly as they are",
    "delete working code and start again; this is a change of storage and configuration, not a rebuild",
    "add a dependency the contract does not allow",
  ]) lines.push(`- ${s}`);
  lines.push("");
  lines.push(`When you have made the changes, say in \`.crestmont/integration-summary.md\` what you changed and why. Your work will be re-checked against the contract and re-rendered against the approved design.`);

  return lines.join("\n");
}

/** The report in words. */
export function describeConformance(r: ConformanceReport): string {
  const v = r.findings.filter((f) => f.severity === "violation");
  const w = r.findings.filter((f) => f.severity === "warning");
  const head = r.ok
    ? `the implementation conforms to the contract (checked: ${r.checked.join("; ")})`
    : `the implementation does NOT conform to the contract: ${v.length} violation(s), ${w.length} warning(s)`;
  const lines = r.findings.map((f) => `  ${f.severity.toUpperCase()} [${f.area}/${f.basis}] ${f.code}${f.file ? ` (${f.file})` : ""}: ${f.detail}`);
  return [head, ...lines].join("\n");
}
