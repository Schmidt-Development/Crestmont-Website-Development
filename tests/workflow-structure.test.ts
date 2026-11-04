// Workflow files have to PARSE, and nothing checked that.
//
// tests/workflow-security.test.ts reads the workflows with regular expressions, which is the right tool for the
// questions it asks (no secret here, no interpolation there) but says nothing about whether GitHub can load the
// file at all. A malformed workflow therefore passed every local check and failed only on GitHub, where the run
// has no jobs and no log -- the least informative failure available.
//
// This happened: an escaped newline inside an inline `node -e` became a REAL newline, which closed a `run: |`
// block scalar early and left `"))')` sitting at the top level.
//
// The repository has no YAML parser (zero runtime dependencies, and the test run installs nothing), so this
// checks the ONE structure that actually broke and that can be checked soundly without one: block scalars are
// closed by indentation. Earlier drafts also tried to balance quotes and to validate step shape by hand; both
// are YAML's job, both produced false positives on valid files (an apostrophe in an unquoted scalar, a step
// beginning `- id:`), and a linter that cries wolf on correct input is worse than no linter. They are left out
// on purpose rather than loosened until they pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), ".github", "workflows");
const files = readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

const indent = (l: string) => l.length - l.trimStart().length;
/** A line that opens a block scalar: `run: |`, `description: >-`, `run: |2` and so on. */
const opensBlock = (l: string) => /:\s*[|>][-+]?\d*\s*$/.test(l) && !/^\s*#/.test(l);

test("[INFRA-002] every workflow's block scalars are closed by indentation, so GitHub can parse the file at all", () => {
  assert.ok(files.length > 0, "there are workflows to check");
  for (const f of files) {
    const lines = readFileSync(path.join(DIR, f), "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!opensBlock(lines[i])) continue;
      const keyIndent = indent(lines[i]);
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length) continue; // an empty block at end of file is legal
      const bodyIndent = indent(lines[j]);
      assert.ok(bodyIndent > keyIndent,
        `${f}:${j + 1}: a "${lines[i].trim()}" block has its first line indented ${bodyIndent}, which is not deeper ` +
        `than the key at ${keyIndent}. The block is empty and this line is parsed as YAML: ${JSON.stringify(lines[j].slice(0, 80))}`);
      // The first line indented less than the body ends the block. It must look like a sibling key, a list item
      // or a comment -- not the tail of a string that a stray newline split in half.
      for (let k = j + 1; k < lines.length; k++) {
        const l = lines[k];
        if (!l.trim() || indent(l) >= bodyIndent) continue;
        assert.ok(/^\s*(-\s|[A-Za-z_][\w.-]*\s*:|#)/.test(l),
          `${f}:${k + 1}: this line ends a "${lines[i].trim()}" block but is not a key, a list item or a comment — ` +
          `the block scalar was almost certainly split by a stray newline: ${JSON.stringify(l.slice(0, 80))}`);
        break;
      }
    }
  }
});

test("[INFRA-002] every workflow declares a name, a trigger and jobs", () => {
  for (const f of files) {
    const text = readFileSync(path.join(DIR, f), "utf8");
    assert.match(text, /^name:\s*\S/m, `${f}: no top-level name`);
    assert.match(text, /^on:/m, `${f}: no top-level on:`);
    assert.match(text, /^jobs:\s*$/m, `${f}: no top-level jobs:`);
  }
});
