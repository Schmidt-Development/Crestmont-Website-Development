// Regression for production run 44456707770 (Owner, 2026-11-19): the workflow's ask() printed the `::add-mask::`
// command and the HTTP status to the same stdout, and the caller captured both with `http=$(ask …)` — so a successful
// HTTP 200 compared unequal to "200", the run failed after the Worker had already acted, and the one-time challenge was
// printed unmasked in the error. scripts/native-ops-ask.sh now writes the status to a file only; these tests run the real
// script with stub `curl` and `wrangler` (nothing is contacted) and check every request path in the workflow uses it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const WORKFLOW = readFileSync(join(ROOT, ".github/workflows/portfolio-native-ops.yml"), "utf8");

/** A sandbox with stub curl (echoes the challenge back in its answer, like an error page might) and stub wrangler. */
function sandbox(opts: { curlExit?: number; curlCode?: string; wranglerFails?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "native-ask-"));
  const bin = join(dir, "bin");
  execFileSync("mkdir", ["-p", bin]);
  // curl: reads the request from stdin (--data-binary @-), writes an answer containing the challenge to -o, prints -w.
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash
out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done
body=$(cat); echo "$body" > "${dir}/request.json"
${opts.curlExit ? `exit ${opts.curlExit}` : ""}
ch=$(node -e 'console.log(JSON.parse(process.argv[1]).challenge)' "$body")
printf '{"slug":"lending-for-beginners","state":"preparing","echo":"%s"}' "$ch" > "$out"
printf '%s' "${opts.curlCode ?? "200"}"
`);
  writeFileSync(join(bin, "wrangler"), `#!/usr/bin/env bash
echo "$@" > "${dir}/wrangler-args"; ${opts.wranglerFails ? "echo 'Authentication error [code: 10000]' >&2; exit 1" : "echo '[WARNING] D1 may be unavailable'"}
`);
  chmodSync(join(bin, "curl"), 0o755); chmodSync(join(bin, "wrangler"), 0o755);
  const run = (body: string) => spawnSync("bash", ["scripts/native-ops-ask.sh", body, join(dir, "r.json")], {
    cwd: ROOT, encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WRANGLER: join(bin, "wrangler"), PRODUCTION_URL: "https://crestmont.test" },
  });
  return { dir, run };
}

test("[PORT-NATIVE-OPS] native-ops-ask: the HTTP status goes to a file as exactly three digits; stdout carries only the mask command; the challenge never reaches the answer", () => {
  const { dir, run } = sandbox();
  const r = run(JSON.stringify({ action: "onboard", url: "https://lendingforbeginners.com/" }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, "r.json.status"), "utf8"), "200\n", "the status file holds exactly the status");
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `stdout is only the mask command: ${JSON.stringify(r.stdout)}`);
  const m = /^::add-mask::([0-9a-f]{64})$/.exec(lines[0]);
  assert.ok(m, "the one-time challenge is masked on the job's own output");
  const sent = JSON.parse(readFileSync(join(dir, "request.json"), "utf8"));
  assert.equal(sent.challenge, m![1], "the request carries the challenge that was masked");
  assert.equal(sent.action, "onboard");
  const answer = readFileSync(join(dir, "r.json"), "utf8");
  assert.ok(!answer.includes(m![1]), "the challenge is scrubbed from the kept answer");
  assert.match(answer, /"state":"preparing".*"echo":"\*\*\*"/);
  assert.ok(!r.stderr.includes(m![1]), "the challenge is never on stderr");
  assert.match(readFileSync(join(dir, "wrangler-args"), "utf8"), /^d1 execute crestmont-production --remote --env production --file \S+c\.sql --yes/);
  // The exact defect: what the old workflow did — capture everything the request step prints — is not 200 …
  assert.notEqual(r.stdout.trim(), "200");
  // … while the status the workflow now reads is.
  assert.equal(readFileSync(join(dir, "r.json.status"), "utf8").trim(), "200");
  // The challenge's working files are gone.
  assert.ok(!readdirSync(tmpdir()).some((f) => existsSync(join(tmpdir(), f, "nonce")) && readFileSync(join(tmpdir(), f, "nonce"), "utf8").includes(m![1])));
});

test("[PORT-NATIVE-OPS] native-ops-ask: a failed challenge write or request yields status 000 and no challenge anywhere but the mask command", () => {
  for (const opts of [{ wranglerFails: true }, { curlExit: 7 }, { curlCode: "garbage" }]) {
    const { dir, run } = sandbox(opts);
    const r = run(JSON.stringify({ action: "advance", slug: "lending-for-beginners" }));
    assert.equal(r.status, 0, `${JSON.stringify(opts)}: ${r.stderr}`);
    assert.equal(readFileSync(join(dir, "r.json.status"), "utf8"), "000\n", JSON.stringify(opts));
    const nonce = /::add-mask::([0-9a-f]{64})/.exec(r.stdout)?.[1];
    assert.ok(nonce, JSON.stringify(opts));
    assert.equal(r.stdout.trim(), `::add-mask::${nonce}`);
    assert.ok(!r.stderr.includes(nonce), "never in error output");
    assert.ok(!existsSync(join(dir, "r.json")) || !readFileSync(join(dir, "r.json"), "utf8").includes(nonce));
  }
});

test("[PORT-NATIVE-OPS] workflow: check, onboard and advance all go through native-ops-ask.sh; no request's output is captured; the status is read from the file", () => {
  assert.ok(!/\$\(\s*ask\b/.test(WORKFLOW), "no `$(ask …)`: the request's output is never captured");
  assert.ok(!/\$\(\s*bash scripts\/native-ops-ask\.sh/.test(WORKFLOW), "the script's output is never captured");
  assert.ok(!/add-mask/.test(WORKFLOW), "masking happens only inside native-ops-ask.sh");
  assert.ok(!/curl[^\n]*api\/ops\/portfolio-native/.test(WORKFLOW), "no direct request bypasses the script");
  assert.match(WORKFLOW, /ask\(\) \{ bash scripts\/native-ops-ask\.sh "\$1" "\$work\/r\.json"; http=\$\(cat "\$work\/r\.json\.status"\); \}/);
  for (const action of ["check", "onboard", "advance", "enqueue"]) assert.match(WORKFLOW, new RegExp(`ask "\\$\\(node -e 'console\\.log\\(JSON\\.stringify\\(\\{ action: "${action}"`), `${action} uses ask`);
  assert.equal((WORKFLOW.match(/\bask "\$\(node/g) ?? []).length, 5, "check, batch enqueue, onboard, resume and each follow-up advance");
  // The exact comparison the defect broke: the status is compared right after the request, from the file.
  assert.equal((WORKFLOW.match(/\[ "\$http" = "200" \]/g) ?? []).length, 5);
  // Read-only status never calls the Worker; resume never forces (only "advance").
  assert.match(WORKFLOW, /name: Ask the production Worker \(one-time challenges\)\n\s+id: ops\n\s+if: inputs\.action != 'status'/);
  assert.ok(!/force["']?\s*:/.test(WORKFLOW), "no request sets force");
});

test("[PORT-NATIVE-OPS] native-prepare-loop: repeats bounded rounds until every required entry is verified, stops on genuine blockers, and never loops past its deadline", () => {
  const dir = mkdtempSync(join(tmpdir(), "native-loop-"));
  const bin = join(dir, "bin");
  execFileSync("mkdir", ["-p", bin]);
  // Each curl call answers the next scripted round (busy, then verified; or a blocker that never changes).
  const rounds = (states: string[][]) => states.map((st) => JSON.stringify({ round: [{ slug: "kyww", state: st[0] }], readiness: [{ slug: "kyww", name: "KYWW", published: true, state: st[0], codes: [] }, { slug: "wcb", name: "WCB", published: false, state: st[1], codes: [] }], previews: {} }));
  const run = (answers: string[], args: string[]) => {
    answers.forEach((a, i) => writeFileSync(join(dir, `a${i}.json`), a));
    writeFileSync(join(dir, "n"), "0");
    writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash
out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done
cat > /dev/null; n=$(cat "${dir}/n"); f="${dir}/a$n.json"; [ -f "$f" ] || f="${dir}/a$(( ${answers.length} - 1 )).json"
cp "$f" "$out"; echo $((n + 1)) > "${dir}/n"; printf 200
`);
    writeFileSync(join(bin, "wrangler"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(bin, "curl"), 0o755); chmodSync(join(bin, "wrangler"), 0o755);
    return spawnSync("bash", ["scripts/native-prepare-loop.sh", join(dir, "out.json"), ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WRANGLER: join(bin, "wrangler"), PRODUCTION_URL: "https://crestmont.test", NATIVE_PREPARE_PAUSE: "0" } });
  };
  // Busy, busy, then verified (wcb is named, so it is required too).
  let r = run(rounds([["preparing", "checking"], ["preparing", "native_verified"], ["native_verified", "native_verified"]]), ["5", "wcb"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /round 3: 2\/2 verified/);
  assert.match(r.stdout, /every required entry is native_verified/);
  assert.equal(JSON.parse(readFileSync(join(dir, "out.json"), "utf8")).readiness[0].state, "native_verified");
  // A genuine blocker (nothing in progress): it stops at once and leaves the gate to fail.
  r = run(rounds([["authorization_required", "native_verified"]]), ["5", "wcb"]);
  assert.match(r.stdout, /round 1: 1\/2 verified; in progress: none/);
  assert.match(r.stdout, /settled: nothing in progress/);
  // Something that stays in progress: bounded by the deadline (0 minutes → one round).
  r = run(rounds([["preparing", "native_verified"]]), ["0", "wcb"]);
  assert.match(r.stdout, /deadline reached after 1 rounds/);
});
