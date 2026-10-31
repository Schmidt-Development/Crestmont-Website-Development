// Operator-configured deploy commands (PREVIEW_DEPLOY_COMMAND, PREVIEW_DELETE_COMMAND, PRODUCTION_DEPLOY_COMMAND),
// executed WITHOUT a shell.
//
// These used to run as `sh -c "$COMMAND"` with the preview or customer-hosting credential in the environment. That
// let any shell construct in the setting run with the credential, and made every argument the runner passes to its
// process helper a potential shell argument (CodeQL js/shell-command-injection-from-environment). Now the setting is
// parsed once, strictly, into a program and arguments:
//
//   [NAME=value ...] npx [--yes|-y] wrangler@<x.y.z> <subcommand> [allowed flags]
//   [NAME=value ...] wrangler <subcommand> [allowed flags]
//
// * Programs: `wrangler`, or `npx` running an exact-version `wrangler@x.y.z` package. Nothing else — in particular not
//   node/npm (they would run code from the exported project with the credential) and never a shell.
// * Subcommands and flags are allow-listed per command. Flags that would make Wrangler load another config, script
//   or asset directory (--config, --assets, --site, a positional script, ...) are refused: the runner generates the
//   Wrangler config itself (private-preview gate, customer Worker name) and that config must be the one deployed.
// * Quoting: '...' and "..." as in POSIX sh. Shell metacharacters (; & | < > ` ( ) { } [ ] * ? ~ # ! \ and newlines)
//   are refused outside quotes; command substitution is refused everywhere.
// * Variables: only `$NAME` / `${NAME}` for the runner-provided values of that command (CRESTMONT_PREVIEW_NAME, ...),
//   substituted as whole argument text — never re-split or re-interpreted. Leading assignments may also reference the
//   command's credential variables (PREVIEW_DEPLOY_ENV / PRODUCTION_DEPLOY_ENV), which go to the environment only.

import { run } from "./exec.ts";
import type { ExecResult } from "./exec.ts";

export type OperatorCommandKind = "preview-deploy" | "preview-delete" | "production-deploy";

interface KindSpec { setting: string; vars: readonly string[]; subcommands: readonly string[]; positional: boolean }
const KINDS: Record<OperatorCommandKind, KindSpec> = {
  "preview-deploy": { setting: "PREVIEW_DEPLOY_COMMAND", vars: ["CRESTMONT_PREVIEW_NAME", "CRESTMONT_JOB_ID", "CRESTMONT_PROJECT_ID"], subcommands: ["deploy"], positional: false },
  "preview-delete": { setting: "PREVIEW_DELETE_COMMAND", vars: ["CRESTMONT_PREVIEW_NAME"], subcommands: ["delete"], positional: true },
  "production-deploy": { setting: "PRODUCTION_DEPLOY_COMMAND", vars: ["CRESTMONT_SITE_WORKER", "CRESTMONT_DEPLOYMENT_ID", "CRESTMONT_SITE_VERSION"], subcommands: ["deploy"], positional: false },
};

/** Wrangler flags allowed after the subcommand: value flags take one argument (`--f v` or `--f=v`). */
const VALUE_FLAGS: Record<string, readonly string[]> = {
  deploy: ["--name", "--message", "--tag", "--compatibility-date", "--env"],
  delete: ["--name", "--env"],
};
const BOOL_FLAGS: Record<string, readonly string[]> = {
  deploy: ["--minify", "--no-minify", "--dry-run", "--keep-vars"],
  delete: ["--force", "--dry-run"],
};

/** Environment names a leading NAME=value assignment may set. */
const ASSIGNABLE = /^(?:WRANGLER_[A-Z0-9_]{1,60}|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|NO_COLOR|FORCE_COLOR|CI)$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const WRANGLER_PKG = /^wrangler@\d{1,4}\.\d{1,4}\.\d{1,4}$/;
/** Runner-provided values substituted into arguments: identifiers, never paths or shell text. */
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

type Part = { lit: string; quoted: boolean } | { v: string };
type Word = Part[];

export interface OperatorCommand {
  kind: OperatorCommandKind;
  program: "wrangler" | "npx";
  assignments: { name: string; value: Word }[];
  args: Word[];
}

export class OperatorCommandError extends Error {
  constructor(message: string) { super(message); this.name = "OperatorCommandError"; }
}

function tokenize(setting: string, text: string): Word[] {
  const fail = (why: string): never => { throw new OperatorCommandError(`${setting}: ${why}`); };
  if (typeof text !== "string" || !text.trim()) fail("is empty");
  if (text.length > 2000) fail("is longer than 2000 characters");
  const words: Word[] = [];
  let word: Word | null = null;
  const push = (p: Part) => { (word ??= []).push(p); };
  const lit = (s: string, quoted: boolean) => {
    const last = word?.[word.length - 1];
    if (last && "lit" in last && last.quoted === quoted) last.lit += s; else push({ lit: s, quoted });
  };
  const variable = (i: number): number => {
    let name = "", j = i + 1;
    if (text[j] === "{") { const end = text.indexOf("}", j); if (end < 0) fail("unterminated ${"); name = text.slice(j + 1, end); j = end + 1; }
    else { while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) name += text[j++]; }
    if (!NAME.test(name)) fail(`"$" must start a variable reference ($NAME or \${NAME}); command substitution and special parameters are not allowed`);
    push({ v: name });
    return j;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t") { if (word) { words.push(word); word = null; } i++; continue; }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) fail("unterminated single quote");
      const s = text.slice(i + 1, end);
      if (/[\r\n\0]/.test(s)) fail("quoted text may not contain line breaks");
      word ??= []; lit(s, true); i = end + 1; continue;
    }
    if (c === '"') {
      word ??= [];
      let j = i + 1, closed = false;
      while (j < text.length) {
        const d = text[j];
        if (d === '"') { closed = true; j++; break; }
        if (d === "`") fail("backticks (command substitution) are not allowed");
        if (/[\r\n\0]/.test(d)) fail("quoted text may not contain line breaks");
        if (d === "\\" && j + 1 < text.length && '"\\$'.includes(text[j + 1])) { lit(text[j + 1], true); j += 2; continue; }
        if (d === "$") { j = variable(j); continue; }
        lit(d, true); j++;
      }
      if (!closed) fail("unterminated double quote");
      i = j; continue;
    }
    if (c === "$") { i = variable(i); continue; }
    if (/[;&|<>`(){}[\]*?~#!\\\r\n\0]/.test(c)) fail(`shell syntax is not supported (found ${JSON.stringify(c)}); give one Wrangler command with plain arguments`);
    lit(c, false); i++;
  }
  if (word) words.push(word);
  return words;
}

const literalText = (w: Word): string | null => w.every((p) => "lit" in p) ? w.map((p) => (p as { lit: string }).lit).join("") : null;

/**
 * Parse an operator command setting. `credentialNames` are the command's *_ENV variables, which leading assignments
 * may reference (e.g. CLOUDFLARE_API_TOKEN="$SITE_CLOUDFLARE_API_TOKEN"). Throws OperatorCommandError.
 */
export function parseOperatorCommand(kind: OperatorCommandKind, text: string, credentialNames: readonly string[] = []): OperatorCommand {
  const spec = KINDS[kind];
  const fail = (why: string): never => { throw new OperatorCommandError(`${spec.setting}: ${why}`); };
  const words = tokenize(spec.setting, text);
  const assignments: { name: string; value: Word }[] = [];
  let k = 0;
  for (; k < words.length; k++) {
    const first = words[k][0];
    if (!first || !("lit" in first) || first.quoted) break;
    const eq = first.lit.indexOf("=");
    if (eq <= 0) break;
    const name = first.lit.slice(0, eq);
    if (!NAME.test(name)) break;
    if (!ASSIGNABLE.test(name)) fail(`may not set ${name} (allowed: WRANGLER_*, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, NO_COLOR, FORCE_COLOR, CI)`);
    const rest = first.lit.slice(eq + 1);
    const value: Word = [...(rest ? [{ lit: rest, quoted: false }] : []), ...words[k].slice(1)];
    for (const p of value) if ("v" in p && !spec.vars.includes(p.v) && !credentialNames.includes(p.v)) fail(`${name} references $${p.v}, which is not provided to this command (use ${[...spec.vars, ...credentialNames].join(", ")})`);
    assignments.push({ name, value });
  }
  const rest = words.slice(k);
  for (const w of rest) for (const p of w) if ("v" in p && !spec.vars.includes(p.v)) fail(`argument references $${p.v}; only ${spec.vars.join(", ")} may appear in arguments (credentials go through assignments)`);
  const prog = rest[0] ? literalText(rest[0]) : null;
  if (!prog) fail("names no program");
  let argStart = 1;
  let program: "wrangler" | "npx";
  if (prog === "wrangler") program = "wrangler";
  else if (prog === "npx") {
    program = "npx";
    while (argStart < rest.length && ["--yes", "-y"].includes(literalText(rest[argStart]) ?? "")) argStart++;
    const pkg = rest[argStart] ? literalText(rest[argStart]) : null;
    if (!pkg || !WRANGLER_PKG.test(pkg)) fail(`npx may only run an exact Wrangler version (npx --yes wrangler@x.y.z ...), got ${pkg ?? "nothing"}`);
    argStart++;
  } else return fail(`program must be wrangler or npx (got ${String(prog).slice(0, 60)}); shells, node and npm are not allowed`);
  const sub = rest[argStart] ? literalText(rest[argStart]) : null;
  if (!sub || !spec.subcommands.includes(sub)) fail(`only "wrangler ${spec.subcommands.join("|")}" is allowed here (got ${sub ?? "no subcommand"})`);
  let positional = 0;
  for (let i = argStart + 1; i < rest.length; i++) {
    const t = literalText(rest[i]);
    const head = t ?? ("lit" in rest[i][0] ? (rest[i][0] as { lit: string }).lit : "");
    if (head.startsWith("-")) {
      const flag = t === null ? head.split("=")[0] : t.split("=")[0];
      if ((BOOL_FLAGS[sub!] ?? []).includes(flag) && t !== null && !t.includes("=")) continue;
      if ((VALUE_FLAGS[sub!] ?? []).includes(flag)) { if (!head.includes("=")) { i++; if (i >= rest.length) fail(`${flag} needs a value`); } continue; }
      fail(`flag ${flag.slice(0, 60)} is not allowed for wrangler ${sub} (allowed: ${[...(VALUE_FLAGS[sub!] ?? []), ...(BOOL_FLAGS[sub!] ?? [])].join(", ")})`);
    }
    if (!spec.positional || ++positional > 1) fail(`positional argument ${String(t ?? "$…").slice(0, 60)} is not allowed for wrangler ${sub} (the runner's generated config decides what is deployed)`);
  }
  return { kind, program: program!, assignments, args: rest.slice(1) };
}

/**
 * Build the program, argv and extra environment for one run. `values` are the runner-provided CRESTMONT_* values and
 * the credential values; argument substitutions must be plain identifiers.
 */
export function materialize(cmd: OperatorCommand, values: Record<string, string | undefined>): { program: "wrangler" | "npx"; args: string[]; env: Record<string, string> } {
  const spec = KINDS[cmd.kind];
  const text = (w: Word, inArgs: boolean): string => w.map((p) => {
    if ("lit" in p) return p.lit;
    const v = values[p.v] ?? "";
    if (inArgs && !SAFE_VALUE.test(v)) throw new OperatorCommandError(`${spec.setting}: refused to pass $${p.v}: value is not a plain identifier`);
    if (v.includes("\0")) throw new OperatorCommandError(`${spec.setting}: $${p.v} contains a NUL byte`);
    return v;
  }).join("");
  const env: Record<string, string> = {};
  for (const a of cmd.assignments) env[a.name] = text(a.value, false);
  return { program: cmd.program, args: cmd.args.map((w) => text(w, true)), env };
}

/**
 * Parse, materialize and run an operator command without a shell. `baseEnv` is the explicit environment (PATH, HOME,
 * proxy, CRESTMONT_* values, credentials); leading assignments are applied on top. A setting the parser refuses is
 * reported as a refused ExecResult (code 126), never executed.
 */
export async function runOperatorCommand(kind: OperatorCommandKind, text: string, credentialNames: readonly string[], baseEnv: Record<string, string>, opts: { cwd: string; timeoutMs: number }): Promise<ExecResult> {
  let m: ReturnType<typeof materialize>;
  try { m = materialize(parseOperatorCommand(kind, text, credentialNames), baseEnv); }
  catch (err) { return { code: 126, stdout: "", stderr: err instanceof Error ? err.message : String(err), timedOut: false, notFound: false, refused: true }; }
  return run(m.program, m.args, { cwd: opts.cwd, env: { ...baseEnv, ...m.env }, timeoutMs: opts.timeoutMs });
}
