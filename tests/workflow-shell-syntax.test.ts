// Every workflow `run:` script must be valid bash. Deploy #157's error-log step ("Why did a page fail?") died with
//   line 9: unexpected EOF while looking for matching `"'
// because the message inside its single-quoted `node -e '…'` contained `deploy\'s` — in bash, `\'` does not escape
// inside single quotes, so the apostrophe ended the string. The step is continue-on-error, so the deploy reported no
// application errors at all, which is exactly the diagnostic it exists to give. `bash -n` catches the whole class.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const DIR = ".github/workflows";

/** Each `run: |` block scalar (any indentation), dedented, with GitHub `${{ … }}` expressions replaced by a word. */
export function runScripts(src: string): { line: number; script: string }[] {
  const lines = src.split("\n"), out: { line: number; script: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*\|[-+]?\s*$/.exec(lines[i]);
    if (!m) continue;
    const body: string[] = [];
    let indent: number | null = null;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === "") { body.push(""); continue; }
      const ind = l.length - l.trimStart().length;
      if (indent === null) indent = ind;
      if (ind < indent || ind <= m[1].length) break;
      body.push(l.slice(indent));
    }
    // The shell that runs it: the step's own `shell:` (searched back to the step's start), else a `defaults.run.shell`.
    let shell = "";
    for (let j = i; j >= 0; j--) {
      const sh = /^\s*shell:\s*(\S+)/.exec(lines[j]); if (sh) { shell = sh[1]; break; }
      if (j < i && /^\s*- /.test(lines[j])) break;
    }
    if (!shell) shell = /\bdefaults:\s*\n\s*run:\s*\n\s*shell:\s*(\S+)/.exec(src)?.[1] ?? "bash";
    if (!/^(bash|sh)\b/.test(shell)) continue;
    out.push({ line: i + 1, script: body.join("\n").replace(/\$\{\{[\s\S]*?\}\}/g, "GH_EXPR") });
  }
  return out;
}

test("[INFRA-002] every workflow run: script is valid bash (bash -n)", () => {
  const bad: string[] = [];
  let checked = 0;
  for (const f of readdirSync(DIR).filter((x) => x.endsWith(".yml") || x.endsWith(".yaml"))) {
    for (const { line, script } of runScripts(readFileSync(`${DIR}/${f}`, "utf8"))) {
      checked++;
      try { execFileSync("bash", ["-n"], { input: script, stdio: ["pipe", "pipe", "pipe"] }); }
      catch (e) { bad.push(`${f}:${line}: ${String((e as { stderr?: Buffer }).stderr ?? e).trim().split("\n")[0]}`); }
    }
  }
  assert.ok(checked > 100, `found the run scripts (${checked})`);
  assert.deepEqual(bad, []);
});

test("[INFRA-002] the bash check sees the defect class it exists for", () => {
  const [s] = runScripts(`jobs:\n  a:\n    steps:\n      - run: |\n          node -e '\n            console.log("an earlier deploy\\'s faults");\n          '\n`);
  assert.throws(() => execFileSync("bash", ["-n"], { input: s.script, stdio: ["pipe", "pipe", "pipe"] }));
});
