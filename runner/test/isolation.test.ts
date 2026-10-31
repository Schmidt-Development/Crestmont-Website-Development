// Sandbox isolation evidence (AI Website Builder readiness, 2026-10-28). The runner inspects every build container it
// starts and judges Docker's actual configuration, so a Docker Desktop that ignored a hardening flag fails the build
// instead of passing silently, and the evidence outlives the container. FAKE docker executor; no daemon needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { JobSandbox, evaluateIsolation } from "../src/sandbox.ts";
import { isolationCheck } from "../src/checks.ts";
import { createWorkspace } from "../src/workspace.ts";
import { makeConfig, fakeDocker, inspectFromRunArgs, tmp } from "./helpers.ts";
import type { FakeDocker } from "./helpers.ts";

function sandbox(override?: FakeDocker["override"]) {
  const cfg = makeConfig({ controlPlaneUrl: "http://cp.invalid", skillsSourceDir: tmp() });
  const ws = createWorkspace(tmp("aib-iso-"), { id: "bld_iso", attempt: 1 });
  const docker = fakeDocker({ override });
  return { sb: new JobSandbox(cfg.jobSandbox, ws, "bld_iso", docker.executor), ws, docker, cfg };
}

test("[AIB-RUNNER] isolation verdict: the runner's own docker run flags pass; each weakened setting is named", async () => {
  const { sb, docker } = sandbox();
  await sb.start();
  const run = docker.calls.find((c) => c[0] === "run" && c.includes("-d"))!;
  const good = inspectFromRunArgs(run);
  assert.deepEqual(evaluateIsolation([good], { uid: 10001, network: "none" }).findings, []);
  const weaken = (f: (x: any) => void) => { const x = structuredClone(good) as any; f(x); return evaluateIsolation(x, { uid: 10001, network: "none" }).findings.join(" | "); }; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.match(weaken((x) => { x.HostConfig.NetworkMode = "bridge"; }), /network is bridge/);
  assert.match(weaken((x) => { x.HostConfig.ReadonlyRootfs = false; }), /writable/);
  assert.match(weaken((x) => { x.HostConfig.CapDrop = []; }), /CapDrop lacks ALL/);
  assert.match(weaken((x) => { x.HostConfig.CapAdd = ["SYS_ADMIN"]; }), /capabilities added: sys_admin/);
  assert.match(weaken((x) => { x.HostConfig.SecurityOpt = []; }), /no-new-privileges/);
  assert.match(weaken((x) => { x.HostConfig.Privileged = true; }), /privileged/);
  assert.match(weaken((x) => { x.HostConfig.PidMode = "host"; }), /host namespace/);
  assert.match(weaken((x) => { x.Config.User = ""; }), /runs as user root/);
  assert.match(weaken((x) => { x.HostConfig.Memory = 0; }), /no memory limit/);
  assert.match(weaken((x) => { x.HostConfig.NanoCpus = 0; }), /no CPU limit/);
  assert.match(weaken((x) => { x.HostConfig.PidsLimit = -1; }), /no process limit/);
  assert.match(weaken((x) => { x.HostConfig.PortBindings = { "80/tcp": [{}] }; }), /ports are published/);
  assert.match(weaken((x) => { x.Mounts.push({ Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock" }); }), /Docker socket is mounted/);
  assert.match(weaken((x) => { x.Mounts.pop(); }), /mounts are/);
  assert.deepEqual(evaluateIsolation(null, { uid: 10001, network: "none" }).findings, ["docker inspect returned no HostConfig"]);
});

test("[AIB-RUNNER] isolation evidence is written per container to the job directory and survives the container's removal", async () => {
  const { sb, ws } = sandbox();
  await sb.start();
  await sb.restart();
  await sb.close();
  const files = readdirSync(path.join(ws.dir, "evidence")).sort();
  assert.deepEqual(files, ["sandbox-isolation-01.json", "sandbox-isolation-02.json"], "one record per container, restarts included");
  const rec = JSON.parse(readFileSync(path.join(ws.dir, "evidence", files[0]), "utf8"));
  assert.equal(rec.schema, "crestmont.sandbox-isolation/1");
  assert.equal(rec.job, "bld_iso");
  assert.equal(rec.ok, true);
  assert.equal(rec.facts.user, "10001:10001");
  assert.deepEqual(rec.facts.mounts.map((m: { destination: string }) => m.destination).sort(), ["/home/builder", "/workspace/repo"]);
  assert.ok(!existsSync(path.join(ws.repo, "evidence")), "evidence is outside the agent's repository");
  const chk = isolationCheck(sb.isolation)!;
  assert.equal(chk.ok, true);
  assert.equal(chk.id, "sandbox-isolation");
});

test("[AIB-RUNNER] a container Docker started without the requested hardening fails the isolation check (and docker inspect failure is not a pass)", async () => {
  const { sb } = sandbox(async (args) => {
    if (args[0] !== "inspect") return undefined;
    const x = inspectFromRunArgs(["run", "-d", "--network", "bridge", "--user", "10001:10001", "--cpus", "2", "--memory", "4g", "--pids-limit", "512",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--mount", "type=bind,src=/r,dst=/workspace/repo", "--mount", "type=bind,src=/h,dst=/home/builder"]);
    return { code: 0, stdout: JSON.stringify([x]), stderr: "", timedOut: false, notFound: false };
  });
  await sb.start();
  const chk = isolationCheck(sb.isolation)!;
  assert.equal(chk.ok, false);
  assert.match(chk.outputTail, /network is bridge/);
  assert.match(chk.outputTail, /root filesystem is writable/);

  const { sb: sb2 } = sandbox(async (args) => (args[0] === "inspect" ? { code: 1, stdout: "", stderr: "daemon error", timedOut: false, notFound: false } : undefined));
  await sb2.start();
  assert.equal(sb2.isolation[0].ok, false);
  assert.match(sb2.isolation[0].findings[0], /docker inspect failed/);
  assert.equal(isolationCheck([]), null, "no container (Agent SDK path): no check");
});
