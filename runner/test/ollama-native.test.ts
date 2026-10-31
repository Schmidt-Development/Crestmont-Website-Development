// Founder decision D4 (2026-10-28): native Windows Ollama is the preferred inference service, separate from the
// untrusted build sandbox. These tests cover what can be checked without the Founder's hardware: the health probe
// (model availability + GPU residency from Ollama's /api/ps), and the isolation invariants of the Windows kit.
// Nothing here claims Ollama works on the Founder's machine; that needs the hardware validation in the docs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ollamaGpuShare, newHealthState } from "../src/health.ts";
import { localModelProbe, runLoop } from "../src/main.ts";
import { silentLogger } from "../src/log.ts";
import { makeConfig } from "./helpers.ts";

const BASE = "http://host.docker.internal:11434/v1";
const MODEL = "qwen3-coder:30b";

function fakeOllama(ps: unknown, models = [MODEL]): typeof fetch {
  return (async (u: string | URL) => {
    const url = new URL(String(u));
    if (url.pathname === "/v1/models") return Response.json({ data: models.map((id) => ({ id })) });
    if (url.pathname === "/api/ps") return ps === 404 ? new Response("not found", { status: 404 }) : Response.json(ps);
    return new Response("?", { status: 404 });
  }) as typeof fetch;
}

test("[AIB-RUNNER] D4: GPU residency is read from Ollama's /api/ps (advisory; null for other providers or an unloaded model)", async () => {
  const gb = 1024 ** 3;
  assert.equal(await ollamaGpuShare(BASE, MODEL, fakeOllama({ models: [{ name: MODEL, model: MODEL, size: 20 * gb, size_vram: 20 * gb }] })), 1);
  assert.equal(await ollamaGpuShare(BASE, MODEL, fakeOllama({ models: [{ name: MODEL, size: 20 * gb, size_vram: 10 * gb }] })), 0.5);
  assert.equal(await ollamaGpuShare(BASE, MODEL, fakeOllama({ models: [{ name: `${MODEL}:latest`, size: 4, size_vram: 1 }] })), 0.25);
  assert.equal(await ollamaGpuShare(BASE, MODEL, fakeOllama({ models: [] })), null, "not loaded yet");
  assert.equal(await ollamaGpuShare(BASE, MODEL, fakeOllama({ models: [{ name: "other:7b", size: 1, size_vram: 1 }] })), null);
  assert.equal(await ollamaGpuShare(BASE, MODEL, fakeOllama(404)), null, "another OpenAI-compatible provider");
  assert.equal(await ollamaGpuShare(BASE, MODEL, (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch), null);
});

test("[AIB-RUNNER] D4: the model probe checks availability, reports residency, and the loop records it in /health", async () => {
  const cfg = makeConfig({ controlPlaneUrl: "http://127.0.0.1:9", skillsSourceDir: "x", local: { ...makeConfig({ controlPlaneUrl: "x", skillsSourceDir: "x" }).local, baseUrl: BASE, model: MODEL } });
  const half = fakeOllama({ models: [{ name: MODEL, size: 10, size_vram: 5 }] });
  assert.deepEqual(await localModelProbe(cfg, half)(), { ok: true, gpuShare: 0.5 });
  assert.deepEqual(await localModelProbe(cfg, fakeOllama({ models: [] }, ["other:7b"]))(), { ok: false, error: `model ${MODEL} is not available on the model server (pull it)` });
  const health = newHealthState({ runnerId: "r", version: "t", provider: "local", model: MODEL });
  const client = { claim: async () => ({ job: null, reason: "none_queued" }) } as never;
  await runLoop({ cfg, client, queryFn: (() => { throw new Error("no agent"); }) as never, manifest: { skills: [] } as never, logger: silentLogger, shouldStop: () => false, once: true, health,
    modelProbe: { check: localModelProbe(cfg, half), intervalMs: 1 } });
  assert.equal(health.modelReachable, true);
  assert.equal(health.modelGpuShare, 0.5);
});

test("[AIB-RUNNER] D4: the Windows kit keeps inference separate from untrusted code: Ollama on localhost only, nothing published, only the runner reaches it through the gateway", () => {
  const dir = path.join(import.meta.dirname, "..", "windows");
  const compose = readFileSync(path.join(dir, "docker-compose.yml"), "utf8");
  const installer = readFileSync(path.join(dir, "Install-CrestmontRunner.ps1"), "utf8");
  assert.match(installer, /OLLAMA_HOST = "127\.0\.0\.1:11434"/, "native Ollama bound to localhost");
  assert.match(installer, /it must be localhost only/, "the installer stops if Ollama listens beyond localhost");
  assert.doesNotMatch(compose, /^\s+ports:/m, "no published ports (Ollama is never exposed through Docker)");
  // The in-Docker alternative is opt-in only.
  assert.match(compose, /profiles: \["ollama-in-docker"\]/);
  // The per-build sandbox has no network; installs use a separate network whose proxy refuses the model host
  // (egress-compose.test.ts proves the proxy policy request by request).
  const sandbox = readFileSync(path.join(import.meta.dirname, "..", "src", "sandbox.ts"), "utf8");
  assert.match(sandbox, /"run", "-d", "--init", "--name", this\.name, \.\.\.this\.hardeningFlags\("none"\)/, "job container: --network none");
});
