// The malware scanner as a RUNNING SERVICE, against a real platform and a real ClamAV daemon.
//
// WHY THIS EXISTS SEPARATELY FROM THE TESTS. tests/scanner.test.ts and tests/scanner-clamav.test.ts drive the
// scanner's modules from inside a test process: they construct a `Scanner`, call `cycle()` once, and assert. That
// proves the logic and, with CLAMD_TEST_PORT, that real ClamAV agrees. What it does not prove is the thing the
// Founder actually depends on: the scanner running as a long-lived process, authenticating itself over HTTP,
// finding work on its own, and picking up again after it is killed. "Its tests pass" is not "it is operational".
//
// So this starts the real entry point — `node scanner/src/main.ts`, the same command the container runs — and
// watches what it does to real rows:
//
//   1. a real HTTP server in front of the real platform routes and the real migrations, on loopback;
//   2. a clean frontend artifact and one carrying the EICAR test signature, stored through the real upload path;
//   3. the scanner started as its own process with its own credential, polling on its own schedule;
//   4. the clean artifact must reach scan_status 'clean' AND its frontend_artifacts row must follow;
//   5. the EICAR artifact must reach 'infected', its artifact must be quarantined, its project must enter
//      artifact_quarantined, and delivery to a build must be refused;
//   6. RECOVERY: the scanner is killed, a third artifact is uploaded while it is down, and it must find and
//      finish that work when it is started again.
//
// It runs the scanner on the host rather than in its container because scanner/src/main.ts accepts only an https
// origin or a loopback address for PLATFORM_URL, and a container cannot reach the host's loopback. The container's
// own hardening — read_only, cap_drop ALL, no published port, its own compose project — is asserted separately by
// tests/scanner-isolation.test.ts. What is under test here is the service's behaviour.
//
//   node --no-warnings scripts/scanner-service-check.ts [--clamd-port 3310] [--port 8795]
//
// Needs a real clamd. Nothing here touches staging or production: an in-memory database and files it creates.
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";

import { createTestApp, createStaff, createCustomer, MemoryStorage } from "../tests/support/app.ts";
import { handle } from "../src/app/app.ts";
import { storeUpload } from "../src/services/files.ts";
import * as DL from "../src/services/design-locked.ts";
import { newId } from "../src/lib/db.ts";
import { ping } from "../scanner/src/clamd.ts";
import { makeZip } from "../runner/test/fixtures/zip-writer.ts";

const argv = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const CLAMD_PORT = Number(opt("--clamd-port", process.env.CLAMD_TEST_PORT ?? "3310"));
const PORT = Number(opt("--port", "8795"));
const SECRET = randomBytes(24).toString("hex");
const EICAR = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join("");

type Outcome = "pass" | "fail" | "undetermined";
const ledger: { id: string; outcome: Outcome; detail: string }[] = [];
const check = (id: string, outcome: Outcome, detail: string) => {
  ledger.push({ id, outcome, detail });
  const mark = outcome === "pass" ? "PASS" : outcome === "fail" ? "FAIL" : "UNDETERMINED";
  console.log(`  [${mark}] ${id} — ${detail}`);
  if (outcome !== "pass") console.log(`::error title=${id}::${detail}`);
};
const expect = (id: string, cond: boolean, pass: string, fail: string) => check(id, cond ? "pass" : "fail", cond ? pass : fail);
const rule = (s: string) => console.log(`\n${"=".repeat(92)}\n${s}\n${"=".repeat(92)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<number> {
  rule(`The malware scanner as a running service (clamd 127.0.0.1:${CLAMD_PORT}, platform 127.0.0.1:${PORT})`);

  let daemon = false;
  try { daemon = await ping({ host: "127.0.0.1", port: CLAMD_PORT, timeoutMs: 20_000 }); } catch { daemon = false; }
  if (!daemon) {
    check("clamd", "undetermined", `no ClamAV daemon answered on 127.0.0.1:${CLAMD_PORT}. Start it (scanner/docker-compose.yml) and run this again. Nothing was scanned, so nothing may be called clean.`);
    return 1;
  }
  check("clamd", "pass", "a real ClamAV daemon answered PING");

  const t = await createTestApp({ FILE_SCANNER_SECRET: SECRET, overrides: { storage: new MemoryStorage() } } as never);
  const staff = await createStaff(t.db, "owner", "scanner-service@crestmont.test");
  const customer = await createCustomer(t.db, "scanner-service-customer@example.test", "Service Check Ltd");

  const project = async (name: string) => {
    const id = newId("prj");
    const at = new Date().toISOString();
    await t.db.prepare(
      `INSERT INTO projects (id, organization_id, name, status, revision_allowance, payment_schedule, created_at, updated_at)
       VALUES (?, ?, ?, 'development', 2, 'upfront', ?, ?)`,
    ).bind(id, customer.organizationId, name, at, at).run();
    return id;
  };

  /** Stored through the real upload path, then recorded as a frontend artifact, exactly as the staff route does. */
  const upload = async (projectId: string, filename: string, bytes: Uint8Array) => {
    const stored = await storeUpload({ db: t.db, storage: (t.env as never as { overrides: { storage: unknown } }).overrides.storage } as never, {
      organizationId: customer.organizationId, projectId,
      file: new File([new Uint8Array(bytes)], filename, { type: "application/zip" }),
      uploadedBy: staff.id, folder: "frontend-artifacts",
    } as never);
    const artifact = await DL.recordArtifact(t.db, {
      projectId, organizationId: customer.organizationId, source: "upload",
      fileId: stored.id, sha256: stored.sha256, sizeBytes: stored.size_bytes, uploadedBy: staff.id, scanStatus: stored.scan_status,
    });
    return { file: stored, artifact };
  };

  const goodZip = makeZip([
    { path: "package.json", body: JSON.stringify({ name: "service-check-frontend", private: true, type: "module" }, null, 2) },
    { path: "index.html", body: "<!doctype html><html><body><div id=\"root\"></div></body></html>" },
    { path: "src/main.tsx", body: "export const App = () => null;\n" },
  ]);
  const badZip = makeZip([
    { path: "package.json", body: JSON.stringify({ name: "infected-frontend", private: true }) },
    { path: "index.html", body: "<!doctype html><html><body></body></html>" },
    { path: "src/notes.txt", body: EICAR },
  ]);

  // The real platform routes behind a real socket, so the scanner authenticates over HTTP like any client.
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://127.0.0.1:${PORT}${req.url}`, {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : Array.isArray(v) ? v.map((x) => [k, x] as [string, string]) : [[k, v] as [string, string]])),
      ...(body && body.length ? { body: new Uint8Array(body) } : {}),
    });
    const answer = await handle(request, t.env);
    res.writeHead(answer.status, Object.fromEntries(answer.headers.entries()));
    res.end(Buffer.from(await answer.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
  console.log(`platform listening on http://127.0.0.1:${PORT}`);

  const env = {
    ...process.env,
    PLATFORM_URL: `http://127.0.0.1:${PORT}`,
    FILE_SCANNER_SECRET: SECRET,
    SCANNER_ID: "service-check",
    CLAMD_HOST: "127.0.0.1",
    CLAMD_PORT: String(CLAMD_PORT),
    POLL_SECONDS: "5",
    HEARTBEAT_SECONDS: "30",
    HEALTH_PORT: "0",
  };
  const entry = path.resolve(import.meta.dirname, "../scanner/src/main.ts");

  let scanner: ChildProcess | null = null;
  const start = (label: string) => {
    const child = spawn(process.execPath, ["--no-warnings", entry], { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => console.log(`    ${label} | ${l}`)));
    child.stderr.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => console.log(`    ${label} ! ${l}`)));
    return child;
  };
  const stop = async (child: ChildProcess | null) => {
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(250);
    if (child.exitCode === null) child.kill("SIGKILL");
  };

  const fileStatus = async (id: string) =>
    (await t.db.prepare(`SELECT scan_status FROM files WHERE id = ?`).bind(id).first<{ scan_status: string }>())?.scan_status ?? "(gone)";

  /** Wait until every named file has left 'pending', or give up. */
  const settle = async (ids: string[], seconds = 180) => {
    for (let i = 0; i < seconds * 2; i++) {
      const all = await Promise.all(ids.map(fileStatus));
      if (all.every((s) => s !== "pending")) return all;
      await sleep(500);
    }
    return await Promise.all(ids.map(fileStatus));
  };

  try {
    // ── 1. the service finds its own work and reports verdicts ────────────────────────────────────────────────
    rule("1. the scanner is started as its own process and left to find the work");
    const cleanProject = await project("Clean artifact");
    const badProject = await project("Infected artifact");
    const good = await upload(cleanProject, "frontend.zip", goodZip);
    const bad = await upload(badProject, "infected.zip", badZip);
    expect("UPLOADS-QUARANTINED", good.file.scan_status === "pending" && bad.file.scan_status === "pending",
      "both uploads start quarantined at scan_status 'pending'",
      `expected both 'pending', got ${good.file.scan_status} and ${bad.file.scan_status}`);

    scanner = start("scanner");
    const settled = await settle([good.file.id, bad.file.id]);
    expect("SERVICE-FOUND-WORK", settled.every((s) => s !== "pending"),
      `the running service found and scanned both files on its own: ${settled.join(", ")}`,
      `the service did not settle both files: ${settled.join(", ")}`);

    expect("CLEAN-VERDICT", (await fileStatus(good.file.id)) === "clean",
      "the clean artifact was confirmed clean by the service",
      `expected 'clean', got '${await fileStatus(good.file.id)}'`);
    expect("INFECTED-VERDICT", (await fileStatus(bad.file.id)) === "infected",
      "the artifact carrying EICAR was quarantined as infected",
      `expected 'infected', got '${await fileStatus(bad.file.id)}'`);

    // ── 2. the verdict reaches the artifact and the project, not just the file ────────────────────────────────
    rule("2. the verdict propagates to the frontend artifact and the project");
    const goodArtifact = await DL.getArtifact(t.db, good.artifact.id);
    const badArtifact = await DL.getArtifact(t.db, bad.artifact.id);
    expect("PROPAGATED-CLEAN", goodArtifact?.scan_status === "clean",
      "the clean artifact's own row shows 'clean', so the dashboard tells the truth",
      `the artifact row says '${goodArtifact?.scan_status}' while its file says 'clean'`);
    expect("PROPAGATED-INFECTED", badArtifact?.scan_status === "infected" && badArtifact?.status === "quarantined",
      "the infected artifact is quarantined, with the reason recorded",
      `expected infected+quarantined, got scan '${badArtifact?.scan_status}' status '${badArtifact?.status}'`);
    const badState = await DL.frontendState(t.db, badProject);
    expect("PROJECT-QUARANTINED", badState.state === "artifact_quarantined",
      "the infected upload moved its project to artifact_quarantined",
      `expected 'artifact_quarantined', got '${badState.state}'`);

    // ── 3. quarantine is enforced where it matters: delivery to a build ───────────────────────────────────────
    rule("3. quarantine enforcement");
    const storage = (t.env as never as { overrides: { storage: unknown } }).overrides.storage as never;
    const refused = await DL.deliverApprovedArtifact(t.db, storage, { id: "bld_probe", project_id: badProject, organization_id: customer.organizationId })
      .then(() => null).catch((e: Error) => e);
    expect("DELIVERY-REFUSED", refused instanceof Error,
      "an infected artifact is refused delivery to a build",
      "an infected artifact was delivered to a build");

    // ── 4. recovery: work that arrived while it was down ──────────────────────────────────────────────────────
    rule("4. recovery — the service is killed, work arrives, and it finishes it when restarted");
    await stop(scanner);
    scanner = null;
    const lateProject = await project("Uploaded while the scanner was down");
    const late = await upload(lateProject, "late.zip", goodZip);
    expect("DOWN-LEAVES-PENDING", (await fileStatus(late.file.id)) === "pending",
      "with no scanner running the new upload stays quarantined, as it must",
      `expected 'pending' while the scanner is down, got '${await fileStatus(late.file.id)}'`);

    scanner = start("restarted");
    const after = await settle([late.file.id]);
    expect("RECOVERY", after[0] === "clean",
      "the restarted service found the work left behind and finished it",
      `after restarting, the pending file is '${after[0]}'`);

    // ── 5. the platform's own view of the scanner ─────────────────────────────────────────────────────────────
    rule("5. what the platform knows about the scanner");
    const beat = await t.db.prepare(`SELECT scanner_id, engine, daemon_ok, signatures_at FROM scanner_heartbeats ORDER BY seen_at DESC LIMIT 1`)
      .first<{ scanner_id: string; engine: string | null; daemon_ok: number; signatures_at: string | null }>()
      .catch(() => null);
    if (!beat) {
      check("HEARTBEAT", "undetermined", "no heartbeat row could be read, so the platform's view of the scanner was not established");
    } else {
      expect("HEARTBEAT", beat.scanner_id === "service-check" && !!beat.engine && beat.daemon_ok === 1,
        `the platform recorded a signed heartbeat from ${beat.scanner_id}: ${beat.engine}, daemon ok, signatures ${beat.signatures_at ?? "date unreadable"}`,
        `the heartbeat is not what the service sent: ${JSON.stringify(beat)}`);
    }
  } finally {
    await stop(scanner);
    await new Promise<void>((r) => server.close(() => r()));
    await t.close();
  }

  const counts = { pass: 0, fail: 0, undetermined: 0 };
  for (const l of ledger) counts[l.outcome]++;
  rule(`${counts.pass} passed, ${counts.fail} failed, ${counts.undetermined} undetermined`);
  for (const l of ledger) if (l.outcome !== "pass") console.log(`  ${l.outcome.toUpperCase()}  ${l.id}: ${l.detail}`);
  return counts.fail || counts.undetermined ? 1 : 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(String((e as Error)?.stack ?? e)); process.exit(2); });
