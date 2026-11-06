// Accepting (and refusing) a Founder-approved frontend artifact.
//
// Everything here runs against the archive LISTING and file text, before extraction. That ordering is the whole
// point: an entry named `../../etc/passwd` has to be caught while it is still a string in an index, not after an
// extractor has written it. §17 items 1-5.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS, describeProblems, shouldReadAsText, unsafePath, validateArtifact } from "../src/frontend/artifact.ts";
import type { ArchiveEntry } from "../src/frontend/artifact.ts";

const f = (path: string, size = 100): ArchiveEntry => ({ path, size, type: "file" });

/** The smallest artifact that is recognised at all, so a test can isolate the one problem it is about. */
const STATIC: ArchiveEntry[] = [f("index.html"), f("styles.css"), f("logo.png", 4096)];
const STATIC_TEXT = { "index.html": "<!doctype html><html><body><h1>Summit Haul</h1></body></html>", "styles.css": "body{margin:0}" };

const codes = (v: ReturnType<typeof validateArtifact>) => v.problems.map((p) => p.code);

test("[FA-001] path traversal and absolute paths are refused before anything is written to disk", () => {
  const nul = "payload" + String.fromCharCode(0) + ".png";
  const v = validateArtifact({
    entries: [
      ...STATIC,
      f("../../etc/passwd"),
      f("src/../../../root/.ssh/authorized_keys"),
      f("/etc/shadow"),
      f("C:\\Windows\\System32\\drivers\\etc\\hosts"),
      f("..\\..\\windows\\system32\\calc"),
      f(nul),
    ],
    text: STATIC_TEXT,
  });

  assert.equal(v.ok, false, "an artifact containing a traversal entry is never accepted");
  const unsafe = v.problems.filter((p) => p.code === "unsafe-path");
  assert.equal(unsafe.length, 6, `every one of the six hostile paths is named, got ${unsafe.map((p) => p.path).join(", ")}`);
  assert.ok(unsafe.every((p) => p.severity === "quarantine"), "and kept for inspection rather than silently dropped");

  // Each is reported with its own reason, so the record says what was wrong rather than just "unsafe".
  const reasons = unsafe.map((p) => p.detail);
  assert.ok(reasons.includes("path traversal"), reasons.join(" | "));
  assert.ok(reasons.includes("absolute path"));
  assert.ok(reasons.includes("drive-qualified absolute path"));
  assert.ok(reasons.includes("embedded NUL in the path"));

  // The judgement is on the RAW path. Normalising first and then asking is how traversal gets through.
  assert.equal(unsafePath("a/../b"), "path traversal");
  assert.equal(unsafePath("assets/img/../img/logo.png"), "path traversal", "even a traversal that happens to resolve inside the tree");
  assert.equal(unsafePath("src/components/Hero.tsx"), null, "and an ordinary path is left alone");
  assert.equal(unsafePath(".gitignore"), null, "a dotfile is not git internals");
  assert.equal(unsafePath(".git/config"), "git internals");
});

test("[FA-002] symlinks and executable payloads are quarantined", () => {
  const v = validateArtifact({
    entries: [
      ...STATIC,
      { path: "node_modules/.bin/x", size: 0, type: "symlink", linkTarget: "/run/secrets/runner-token" },
      f("tools/setup.exe", 50_000),
      f("lib/native.so", 9_000),
      f("scripts/bootstrap.sh", 400),
      { path: "pipe", size: 0, type: "fifo" },
    ],
    text: STATIC_TEXT,
  });

  assert.equal(v.ok, false);
  const bad = v.problems.filter((p) => p.severity === "quarantine");
  assert.equal(bad.filter((p) => p.code === "symlink").length, 1);
  // The target is recorded: a link to /run/secrets is a very different event from a link to ./dist.
  assert.match(bad.find((p) => p.code === "symlink")!.detail, /\/run\/secrets\/runner-token/);
  assert.equal(bad.filter((p) => p.code === "executable-payload").length, 3, "the .exe, the .so and the shell script");
  assert.equal(bad.filter((p) => p.code === "unsupported-entry").length, 1, "and an entry type that is neither file nor directory");
});

test("[FA-003] credentials committed into the package are caught, and never echoed back", () => {
  const aws = "AKIA" + "ABCDEFGHIJKLMNOP";
  const stripe = "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc";
  // Assembled rather than written out. The repository's own secret scan reads every tracked file and refuses a
  // credential-shaped literal — correctly, since it cannot know this one is a fixture. Composing it keeps the
  // scanner that guards the repository and the scanner this test exercises from fighting over the same bytes.
  const DASHES = "-".repeat(5);
  const v = validateArtifact({
    entries: [...STATIC, f("src/config.js"), f("deploy/id_rsa")],
    text: {
      ...STATIC_TEXT,
      "src/config.js": `export const AWS_ACCESS_KEY_ID = "${aws}";\nexport const STRIPE = "${stripe}";`,
      "deploy/id_rsa": `${DASHES}BEGIN OPENSSH PRIVATE KEY${DASHES}\nb3BlbnNzaC1rZXk=\n${DASHES}END OPENSSH PRIVATE KEY${DASHES}`,
    },
  });

  assert.equal(v.ok, false, "an artifact carrying live credentials is quarantined, not imported");
  const creds = v.problems.filter((p) => p.code === "embedded-credential");
  assert.equal(creds.length, 3, `two in config.js and the private key, got ${JSON.stringify(creds.map((c) => [c.path, c.detail]))}`);
  assert.deepEqual([...new Set(creds.map((c) => c.path))].sort(), ["deploy/id_rsa", "src/config.js"]);

  // A report that quotes the secret turns the build log into a second copy of it.
  const report = describeProblems(v);
  assert.ok(!report.includes(aws), "the AWS key is not reproduced in the report");
  assert.ok(!report.includes(stripe), "nor the Stripe key");
  assert.match(report, /aws-access-key/, "the kind of credential is named instead");
  assert.match(report, /stripe-live-key/);

  // And ordinary frontend code is not a credential. A false positive here blocks a legitimate import.
  const clean = validateArtifact({
    entries: [...STATIC, f("src/api.js")],
    text: { ...STATIC_TEXT, "src/api.js": "const token = import.meta.env.VITE_PUBLIC_TOKEN;\nconst key = props.key;\n// sk-is-not-a-key" },
  });
  assert.deepEqual(clean.problems.filter((p) => p.code === "embedded-credential"), []);
  assert.equal(clean.ok, true);
});

test("[FA-004] dependencies that bypass the registry are quarantined; install hooks are surfaced, not hidden", () => {
  const v = validateArtifact({
    entries: [...STATIC, f("package.json"), f("src/App.jsx")],
    text: {
      ...STATIC_TEXT,
      "package.json": JSON.stringify({
        name: "approved-frontend",
        dependencies: { react: "18.3.1", "helper-lib": "git+https://github.com/someone/helper.git" },
        devDependencies: { tooling: "file:../../../etc" },
        scripts: { build: "vite build", postinstall: "node ./scripts/setup.js" },
      }),
    },
  });

  assert.equal(v.ok, false, "a dependency resolving outside the registry stops the import");
  const dep = v.problems.filter((p) => p.code === "unvetted-dependency");
  assert.equal(dep.length, 2, `the git dependency and the file: one, got ${dep.length}`);
  assert.ok(dep.every((p) => p.severity === "quarantine"));
  assert.match(dep.map((p) => p.detail).join(" "), /helper-lib/);

  // An install hook is real code execution at import time, but a legitimate project may have one, so it is
  // reported for a person to decide rather than used to reject the artifact outright.
  const hook = v.problems.find((p) => p.code === "install-hook");
  assert.ok(hook, "the postinstall script is reported");
  assert.equal(hook!.severity, "warn");
  assert.match(hook!.detail, /postinstall/);

  // Warnings alone never block: the same artifact without the bad dependencies is accepted despite the hook.
  const warnOnly = validateArtifact({
    entries: [...STATIC, f("package.json"), f("src/App.jsx")],
    text: { ...STATIC_TEXT, "package.json": JSON.stringify({ dependencies: { react: "18.3.1" }, scripts: { postinstall: "node ./scripts/setup.js" } }) },
  });
  assert.equal(warnOnly.ok, true, "a warning is not a refusal");
  assert.ok(codes(warnOnly).includes("install-hook"));
  assert.ok(codes(warnOnly).includes("no-lockfile"), "and a missing lockfile is a warning too: the baseline may drift");
});

test("[FA-005] the four supported frontends are told apart, and anything else is refused by name", () => {
  const staticSite = validateArtifact({ entries: STATIC, text: STATIC_TEXT });
  assert.equal(staticSite.framework, "static");
  assert.equal(staticSite.ok, true);
  assert.deepEqual(staticSite.assets, ["logo.png"], "the site's own assets are listed for the manifest");
  assert.deepEqual(staticSite.entryPoints, ["index.html"]);

  const react = validateArtifact({
    entries: [f("package.json"), f("src/App.jsx"), f("src/index.js"), f("public/index.html")],
    text: { "package.json": JSON.stringify({ dependencies: { react: "18.3.1", "react-dom": "18.3.1" } }), "package-lock.json": "{}" },
  });
  assert.equal(react.framework, "react");
  assert.equal(react.ok, true);

  const reactTs = validateArtifact({
    entries: [f("package.json"), f("tsconfig.json"), f("src/App.tsx")],
    text: { "package.json": JSON.stringify({ dependencies: { react: "18.3.1" } }), "tsconfig.json": "{}", "package-lock.json": "{}" },
  });
  assert.equal(reactTs.framework, "react-ts", "TypeScript changes how the project is built, so it is a distinct target");

  const vite = validateArtifact({
    entries: [f("package.json"), f("vite.config.ts"), f("index.html"), f("src/main.tsx"), f("src/assets/hero.webp", 80_000)],
    text: {
      "package.json": JSON.stringify({ dependencies: { react: "18.3.1" }, devDependencies: { vite: "5.4.8" }, scripts: { build: "vite build" } }),
      "vite.config.ts": "export default {}", "tsconfig.json": "{}", "package-lock.json": "{}", "index.html": "<div id=root></div>",
    },
  });
  assert.equal(vite.framework, "vite", "a Vite project is detected from its config even though it is also React");
  assert.equal(vite.ok, true);
  assert.deepEqual(vite.problems, [], `a complete, clean artifact produces no problems at all: ${describeProblems(vite)}`);
  assert.match(describeProblems(vite), /accepted as a vite project/);

  // Anything else is refused with a message that says what IS supported, because the Founder has to act on it.
  const unknown = validateArtifact({
    entries: [f("main.py"), f("requirements.txt")],
    text: { "requirements.txt": "django==5.0" },
  });
  assert.equal(unknown.framework, null);
  assert.equal(unknown.ok, false);
  const why = unknown.problems.find((p) => p.code === "unsupported-framework")!;
  assert.match(why.detail, /React/);
  assert.match(why.detail, /Vite/);
  assert.match(why.detail, /static HTML/);
});

test("[FA-006] an incomplete or malformed package cannot reach the build step", () => {
  // React sources with no manifest: npm install has nothing to install, and the build would fail inside the
  // sandbox after an extraction. Refused at the listing instead.
  const noPkg = validateArtifact({ entries: [f("src/App.jsx"), f("src/index.jsx")], text: {} });
  assert.equal(noPkg.framework, "react");
  assert.equal(noPkg.ok, false);
  assert.ok(codes(noPkg).includes("missing-package-json"), codes(noPkg).join(","));

  const badJson = validateArtifact({ entries: [...STATIC, f("package.json")], text: { ...STATIC_TEXT, "package.json": "{ not json," } });
  assert.equal(badJson.ok, false);
  assert.ok(codes(badJson).includes("invalid-package-json"));

  const empty = validateArtifact({ entries: [], text: {} });
  assert.equal(empty.ok, false);
  assert.ok(codes(empty).includes("empty-archive"));
});

test("[FA-007] an archive is a website, not a disk image", () => {
  const huge = validateArtifact({ entries: [...STATIC, f("assets/raw.mov", LIMITS.fileBytes + 1)], text: STATIC_TEXT });
  assert.ok(codes(huge).includes("file-too-large"), codes(huge).join(","));
  assert.equal(huge.ok, false);

  // A small archive that expands enormously is a bomb, and it is caught from the listing: no extraction needed.
  const bomb = validateArtifact({ entries: [...STATIC, f("padding.css", 40 * 1024 * 1024)], text: STATIC_TEXT, compressedBytes: 100_000 });
  assert.ok(codes(bomb).includes("expansion-ratio"), codes(bomb).join(","));
  assert.equal(bomb.ok, false);

  const many = validateArtifact({ entries: Array.from({ length: LIMITS.entries + 1 }, (_, i) => f(`a/${i}.css`, 1)), text: {} });
  assert.ok(codes(many).includes("too-many-entries"));

  // A real site of ordinary size is not caught by any of them.
  const normal = validateArtifact({
    entries: [...STATIC, ...Array.from({ length: 400 }, (_, i) => f(`assets/img-${i}.webp`, 120_000))],
    text: STATIC_TEXT, compressedBytes: 30 * 1024 * 1024,
  });
  assert.equal(normal.ok, true, describeProblems(normal));
  assert.equal(normal.assets.length, 401);
});

test("[FA-008] validation reads manifests and source, and never loads binary assets into memory", () => {
  assert.equal(shouldReadAsText("package.json", 2_000), true);
  assert.equal(shouldReadAsText("src/App.tsx", 20_000), true);
  assert.equal(shouldReadAsText(".env.production", 200), true, "an env file is exactly where a committed secret lives");
  assert.equal(shouldReadAsText("assets/hero.png", 400_000), false, "a PNG is never scanned as text");
  assert.equal(shouldReadAsText("fonts/Inter.woff2", 90_000), false);
  assert.equal(shouldReadAsText("src/bundle.js", 8 * 1024 * 1024), false, "and nothing oversized is read at all");
});
