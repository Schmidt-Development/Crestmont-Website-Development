// Hardware-based local model selection for the Windows build machine.
//   node --no-warnings windows/select-model.ts <hardware.json>      (hardware.json from Discover-Hardware.ps1)
// Prints a JSON recommendation: model tag, quantization, context length, Ollama parallelism, KV-cache settings,
// per-build container limits, alternatives, and - when the machine is not good enough - a plain "insufficient" verdict.
// The Install script runs this inside the runner image, so the Windows host needs no Node.js.
//
// The table uses only figures from the sources below; numbers marked ESTIMATE are this runner's own conservative
// headroom rules (KV cache + runtime overhead), to be confirmed on the machine with `ollama ps` (PROCESSOR = 100% GPU).
// Sources (retrieved 2026-10-27):
//  S1 https://huggingface.co/Qwen/qwen3-coder-30b-a3b-instruct      Apache-2.0; 30.5B total / 3.3B active; 256K native ctx;
//     "If you encounter out-of-memory (OOM) issues, consider reducing the context length to a shorter value, such as 32,768."
//  S2 https://unsloth.ai/docs/models/tutorials/qwen3-coder-how-to-run-locally   30B-A3B 4-bit: ">= 18GB unified memory" for 6+ tok/s;
//     Q8 (32.5GB file) needs ">= 33GB unified memory"; runs on less memory but slower.
//  S3 https://theaitechpulse.com/qwen3-coder-ollama-2026 (secondary; quotes ollama.com/library/qwen3-coder/tags): qwen3-coder:30b
//     = Q4_K_M 19GB; 30b-a3b-q8_0 32GB; 480b q4_K_M 290GB.  (The official tags page could not be fetched from the build host.)
//  S4 https://registry.ollama.ai/library/qwen3-coder-next:q8_0      qwen3-coder-next:q8_0 85GB, 79.7B, 256K ctx, tools, Apache-2.0.
//  S5 https://huggingface.co/Qwen/Qwen3-Coder-Next-GGUF             Apache-2.0; 80B total / 3B active; Q4_K_M 48.4GB.
//  S6 https://huggingface.co/mistralai/Devstral-Small-2-24B-Instruct-2512   Apache-2.0; 24B; "single RTX 4090 or a Mac with 32GB RAM";
//     Ollama library entry devstral-small-2; tool calling.
//  S7 https://unsloth.ai/docs/models/tutorials/devstral-2           Devstral Small 2 Q8 fits in 25GB; recommended min context 16,384.
//  S8 https://dell.huggingface.co/models/openai/gpt-oss-20b          Apache-2.0; 21B / 3.6B active; "run within 16GB of memory";
//     function calling; `ollama pull gpt-oss:20b`.
//  S9 https://docs.ollama.com/faq   default ctx 4096; OLLAMA_CONTEXT_LENGTH; OLLAMA_NUM_PARALLEL default 1 and RAM scales with
//     NUM_PARALLEL x CONTEXT_LENGTH; OLLAMA_KV_CACHE_TYPE q8_0 ~ half of f16; OLLAMA_FLASH_ATTENTION=1; ollama ps PROCESSOR column.
//  S10 https://docs.ollama.com/windows  Windows 10 22H2+; NVIDIA driver 551.61+; AMD via ROCm/Vulkan; logs %LOCALAPPDATA%\Ollama.
//  S11 https://docs.openhands.dev/openhands/usage/llms/local-llms   agents need a large context: OLLAMA_CONTEXT_LENGTH >= 22000.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface HardwareGpu {
  name: string;
  vendor: "nvidia" | "amd" | "intel" | "other";
  vramGB: number | null;
  /** false when VRAM came from Win32_VideoController.AdapterRAM (a 32-bit field that caps near 4 GB). */
  vramReliable: boolean;
  driverVersion: string | null;
  source: string;
}

export interface Hardware {
  schema: "crestmont.hardware/1";
  os?: { caption?: string; build?: number | null };
  cpu: { name: string; cores: number; logicalProcessors: number };
  memory: { totalGB: number; freeGB?: number };
  gpus: HardwareGpu[];
  disks: { drive: string; freeGB: number; totalGB?: number }[];
  virtualization?: { wslInstalled?: boolean; wslVersion2?: boolean | null };
  docker?: { installed?: boolean; serverReachable?: boolean };
  ollama?: { installed?: boolean };
}

export interface Candidate {
  id: string;
  model: string;
  quantization: string;
  fileGB: number;
  license: string;
  minVramGB: number;
  contextTokens: number;
  note: string;
  sources: string[];
}

/** KV cache + runtime headroom on top of the model file for a 32K context, single request. ESTIMATE. */
export const HEADROOM_GB = 4;

export const CANDIDATES: Record<string, Candidate> = {
  "qwen3-coder-next-q8": {
    id: "qwen3-coder-next-q8", model: "qwen3-coder-next:q8_0", quantization: "Q8_0", fileGB: 85, license: "Apache-2.0",
    minVramGB: 85 + HEADROOM_GB, contextTokens: 65_536,
    note: "80B MoE (3B active) coding model with tool calling; largest single-node option that fits Ollama on one machine.", sources: ["S4", "S5"],
  },
  "qwen3-coder-30b-q8": {
    id: "qwen3-coder-30b-q8", model: "qwen3-coder:30b-a3b-q8_0", quantization: "Q8_0", fileGB: 32, license: "Apache-2.0",
    minVramGB: 32 + HEADROOM_GB, contextTokens: 32_768,
    note: "Qwen3-Coder 30B-A3B at 8-bit: best fidelity of the 30B; Unsloth: >= 33GB memory for Q8.", sources: ["S1", "S2", "S3"],
  },
  "qwen3-coder-30b-q4": {
    id: "qwen3-coder-30b-q4", model: "qwen3-coder:30b", quantization: "Q4_K_M", fileGB: 19, license: "Apache-2.0",
    minVramGB: 19 + HEADROOM_GB, contextTokens: 32_768,
    note: "Qwen3-Coder 30B-A3B at 4-bit (Ollama default tag): the default recommendation for a single 24GB GPU.", sources: ["S1", "S2", "S3"],
  },
  "devstral-small-2": {
    id: "devstral-small-2", model: "devstral-small-2", quantization: "default tag (verify with `ollama show`)", fileGB: 25, license: "Apache-2.0",
    minVramGB: 24, contextTokens: 32_768,
    note: "Mistral's 24B dense agentic coder; vendor states a single RTX 4090 suffices. Dense: slower than MoE when offloaded to CPU.", sources: ["S6", "S7"],
  },
  "gpt-oss-20b": {
    id: "gpt-oss-20b", model: "gpt-oss:20b", quantization: "MXFP4 (as published)", fileGB: 14, license: "Apache-2.0",
    minVramGB: 16, contextTokens: 32_768,
    note: "General model with function calling that the vendor says runs within 16GB; coding-agent quality on this runner is unverified.", sources: ["S8"],
  },
};

export interface Recommendation {
  schema: "crestmont.model-recommendation/1";
  ok: boolean;
  tier: "A" | "B" | "C" | "D" | "E" | "insufficient";
  /** One-line verdict for the Founder. */
  summary: string;
  model: string | null;
  quantization: string | null;
  license: string | null;
  contextTokens: number;
  ollama: { numParallel: number; flashAttention: boolean; kvCacheType: "f16" | "q8_0"; keepAlive: string; contextLength: number };
  /** Per-build container limits leaving the rest of the machine for the model server. */
  jobLimits: { cpus: number; memoryGB: number; diskGB: number };
  acceleration: "gpu" | "gpu+cpu-offload" | "cpu-only" | "none";
  alternatives: string[];
  reasons: string[];
  warnings: string[];
  blockers: string[];
  /**
   * The subset of `blockers` that only concerns the model choice (no recommended tier fits). The installer's -Model
   * override may clear these, and only these: driver, disk, WSL, Docker and schema blockers always stop the install.
   */
  modelChoiceBlockers: string[];
  sources: string[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function usableVram(hw: Hardware): { totalGB: number; largestGB: number; vendor: string | null; reliable: boolean; count: number } {
  // Ollama on Windows accelerates NVIDIA and AMD GPUs (S10); Intel and others count as no acceleration.
  const gpus = normalizeHardware(hw).gpus.filter((g) => (g.vendor === "nvidia" || g.vendor === "amd") && typeof g.vramGB === "number" && g.vramGB > 0);
  const total = gpus.reduce((n, g) => n + (g.vramGB ?? 0), 0);
  const largest = gpus.reduce((n, g) => Math.max(n, g.vramGB ?? 0), 0);
  return { totalGB: round1(total), largestGB: round1(largest), vendor: gpus[0]?.vendor ?? null, reliable: gpus.every((g) => g.vramReliable), count: gpus.length };
}

/**
 * NVIDIA driver version as NVIDIA publishes it ("551.61"). nvidia-smi reports that form. Win32_VideoController (used
 * when nvidia-smi is missing) reports the Windows driver-store form ("31.0.15.5161"): the last five digits of its last
 * two fields are the NVIDIA version (15.5161 -> 551.61). Returns null for anything else.
 */
export function nvidiaDriverVersion(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  const win = /^\d+\.\d+\.(\d+)\.(\d{1,4})$/.exec(s);
  if (win) {
    const digits = (win[1] + win[2].padStart(4, "0")).slice(-5);
    if (digits.length < 5) return null;
    return `${Number(digits.slice(0, 3))}.${digits.slice(3)}`;
  }
  const nv = /^(\d{3,})\.(\d{1,2})(?:\.\d+)?$/.exec(s);
  return nv ? `${Number(nv[1])}.${nv[2].padStart(2, "0")}` : null;
}

export function nvidiaDriverTooOld(v: string | null | undefined): boolean {
  const n = nvidiaDriverVersion(v);
  if (!n) return false;
  const [major, minor] = n.split(".").map(Number);
  return major < 551 || (major === 551 && minor < 61);
}

const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? v as T[] : v && typeof v === "object" ? [v as T] : []);
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Tolerant view of a Discover-Hardware.ps1 document. Windows PowerShell 5.1's ConvertTo-Json can emit a one-element
 * array as a bare object, numbers can arrive as strings and vendor casing varies. Missing sections stay missing, so
 * the checks below still see "unknown" rather than a made-up value.
 */
export function normalizeHardware(raw: unknown): Hardware {
  const h = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const cpu = (h.cpu && typeof h.cpu === "object" ? h.cpu : {}) as Record<string, unknown>;
  const mem = (h.memory && typeof h.memory === "object" ? h.memory : {}) as Record<string, unknown>;
  const vendors = ["nvidia", "amd", "intel"];
  return {
    ...(h as unknown as Hardware),
    cpu: { name: String(cpu.name ?? "?"), cores: num(cpu.cores) ?? 0, logicalProcessors: num(cpu.logicalProcessors) ?? 0 },
    memory: { ...(mem as object), totalGB: num(mem.totalGB) ?? 0 },
    gpus: asArray<Record<string, unknown>>(h.gpus).map((g) => {
      const vendor = String(g.vendor ?? "").toLowerCase();
      return {
        name: String(g.name ?? "GPU"),
        vendor: (vendors.includes(vendor) ? vendor : "other") as HardwareGpu["vendor"],
        vramGB: num(g.vramGB),
        vramReliable: g.vramReliable === true,
        driverVersion: g.driverVersion === null || g.driverVersion === undefined ? null : String(g.driverVersion),
        source: String(g.source ?? "unknown"),
      };
    }),
    disks: asArray<Record<string, unknown>>(h.disks).map((d) => {
      const total = num(d.totalGB);
      return { drive: String(d.drive ?? "?"), freeGB: num(d.freeGB) ?? 0, ...(total !== null ? { totalGB: total } : {}) };
    }),
  };
}

/**
 * Decode hardware.json bytes: UTF-8 with or without BOM (`Out-File -Encoding utf8` in Windows PowerShell 5.1 writes a
 * BOM) or UTF-16 (what plain `>` redirection writes in Windows PowerShell 5.1).
 */
export function parseHardwareBytes(buf: Uint8Array): Hardware {
  const b = Buffer.from(buf);
  let text: string;
  if (b[0] === 0xff && b[1] === 0xfe) text = b.subarray(2).toString("utf16le");
  else if (b[0] === 0xfe && b[1] === 0xff) { const sw = Buffer.from(b.subarray(2)); sw.swap16(); text = sw.toString("utf16le"); }
  else if (b.length >= 2 && b[0] !== 0 && b[1] === 0) text = b.toString("utf16le");
  else text = b.toString("utf8");
  return normalizeHardware(JSON.parse(text.replace(/^﻿/, "")));
}

export function selectModel(input: Hardware): Recommendation {
  const hw = normalizeHardware(input);
  const reasons: string[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  const modelChoiceBlockers: string[] = [];
  if (hw.schema !== "crestmont.hardware/1") blockers.push(`unexpected hardware schema ${String(hw.schema)} (run Discover-Hardware.ps1 from this release)`);
  const ram = Number(hw.memory?.totalGB) || 0;
  const threads = Number(hw.cpu?.logicalProcessors) || Number(hw.cpu?.cores) || 1;
  const vram = usableVram(hw);
  const bestDisk = [...(hw.disks ?? [])].sort((a, b) => b.freeGB - a.freeGB)[0];
  reasons.push(`CPU ${hw.cpu?.name ?? "?"} (${hw.cpu?.cores ?? "?"} cores / ${threads} threads), RAM ${ram} GB, accelerated GPU memory ${vram.totalGB} GB across ${vram.count} GPU(s) (largest ${vram.largestGB} GB).`);

  for (const g of hw.gpus ?? []) {
    if (g.vendor === "nvidia" && nvidiaDriverTooOld(g.driverVersion)) blockers.push(`NVIDIA driver ${nvidiaDriverVersion(g.driverVersion)} (reported as ${g.driverVersion}) on ${g.name} is older than 551.61, the minimum Ollama documents for Windows (S10). Update the driver.`);
    if ((g.vendor === "nvidia" || g.vendor === "amd") && !g.vramReliable) warnings.push(`VRAM of ${g.name} was read from Win32_VideoController (32-bit field, caps near 4 GB); install the vendor tools (nvidia-smi ships with the NVIDIA driver) and re-run discovery for an accurate figure.`);
    if (g.vendor === "intel") warnings.push(`${g.name}: Intel GPUs are not listed as accelerated by Ollama on Windows (S10); treated as CPU-only.`);
  }
  if (vram.count > 1) warnings.push("Several GPUs: Ollama can split a model across GPUs, but the tiers below are chosen on total VRAM; confirm with `ollama ps` that the model is 100% GPU.");
  if (hw.virtualization && hw.virtualization.wslInstalled === false) blockers.push("WSL is not installed: Docker Desktop's WSL 2 backend (needed for the build sandboxes) requires it. Run `wsl --install` as Administrator and reboot.");
  if (hw.docker && hw.docker.installed === false) blockers.push("Docker Desktop is not installed (needed for the runner and the per-build sandbox containers).");

  // Tier selection on accelerated VRAM; CPU-only fallback on RAM (MoE models with ~3B active parameters).
  let pick: Candidate | null = null;
  let tier: Recommendation["tier"] = "insufficient";
  let accel: Recommendation["acceleration"] = "none";
  const alternatives: string[] = [];
  if (vram.totalGB >= CANDIDATES["qwen3-coder-next-q8"].minVramGB && ram >= 64) {
    pick = CANDIDATES["qwen3-coder-next-q8"]; tier = "A"; accel = "gpu";
    alternatives.push(`${CANDIDATES["qwen3-coder-30b-q8"].model} (faster, smaller; allows OLLAMA_NUM_PARALLEL=2 for builds + drafts)`);
  } else if (vram.totalGB >= CANDIDATES["qwen3-coder-30b-q8"].minVramGB) {
    pick = CANDIDATES["qwen3-coder-30b-q8"]; tier = "B"; accel = "gpu";
    alternatives.push(`${CANDIDATES["devstral-small-2"].model} (24B dense agentic coder, Apache-2.0)`, `${CANDIDATES["qwen3-coder-30b-q4"].model} (4-bit; more room for context)`);
  } else if (vram.totalGB >= CANDIDATES["qwen3-coder-30b-q4"].minVramGB) {
    pick = CANDIDATES["qwen3-coder-30b-q4"]; tier = "C"; accel = "gpu";
    alternatives.push(`${CANDIDATES["devstral-small-2"].model} (vendor: fits a single RTX 4090)`);
  } else if (vram.totalGB >= 16 && ram >= 32) {
    pick = CANDIDATES["qwen3-coder-30b-q4"]; tier = "D"; accel = "gpu+cpu-offload";
    warnings.push("The 19 GB model does not fit entirely in GPU memory: Ollama offloads layers to the CPU and generation slows down (S2: works with less memory, but slower). Measure tokens/s in the validation run.");
    alternatives.push(`${CANDIDATES["gpt-oss-20b"].model} (fits within 16 GB per the vendor; agentic coding quality unverified here)`);
  } else if (ram >= 48 && threads >= 8) {
    pick = CANDIDATES["qwen3-coder-30b-q4"]; tier = "E"; accel = "cpu-only";
    warnings.push("CPU-only inference: workable for the validation build because the model activates ~3B parameters per token (S1), but expect long build times. Not recommended for production volume.");
  } else {
    modelChoiceBlockers.push(`Insufficient hardware for an agentic coding model: needs at least a 16 GB NVIDIA/AMD GPU with 32 GB RAM, or 48 GB RAM and 8+ CPU threads for slow CPU-only inference (found ${vram.totalGB} GB GPU, ${ram} GB RAM, ${threads} threads).`);
    blockers.push(...modelChoiceBlockers);
  }

  // Context: 32K default (S1 OOM advice; S11 needs >= 22000), 64K when memory clearly allows.
  let ctx = pick?.contextTokens ?? 32_768;
  if (pick && tier === "B" && vram.totalGB >= pick.minVramGB + 12) ctx = 65_536;
  const kvCacheType: "f16" | "q8_0" = accel === "gpu" && vram.totalGB >= (pick?.minVramGB ?? 0) + 8 ? "f16" : "q8_0";
  if (kvCacheType === "q8_0" && pick) reasons.push("KV cache q8_0 (about half the memory of f16 with minimal quality loss, S9) to fit the 32K context.");
  const numParallel = 1;
  reasons.push(`OLLAMA_NUM_PARALLEL=${numParallel}: memory scales with NUM_PARALLEL x CONTEXT_LENGTH (S9); one build or one draft at a time.`);

  // Disk: model file + images + workspaces + checkpoints. ESTIMATE: 40 GB beyond the model.
  const diskNeeded = (pick?.fileGB ?? 20) + 40;
  if (!bestDisk || bestDisk.freeGB < diskNeeded) blockers.push(`Free disk: needs about ${diskNeeded} GB (model + images + workspaces; estimate), largest free is ${bestDisk ? `${bestDisk.freeGB} GB on ${bestDisk.drive}` : "unknown"}.`);
  if (ram < 32 && pick) warnings.push("Less than 32 GB RAM: Docker Desktop, the runner and the build containers compete with the model server.");

  // Per-build container limits: a quarter of the threads (2..8) and ~15% of RAM (4..8 GB). ESTIMATE.
  const jobLimits = {
    cpus: Math.min(8, Math.max(2, Math.floor(threads / 4))),
    memoryGB: Math.min(8, Math.max(4, Math.floor(ram * 0.15))),
    diskGB: 4,
  };

  const ok = !!pick && blockers.length === 0;
  const summary = !pick
    ? "INSUFFICIENT: this machine cannot run a local coding model at useful speed. Do not deploy the local runner on it."
    : `${ok ? "" : "BLOCKED until fixed: "}Tier ${tier}: ${pick.model} (${pick.quantization}, ${pick.license}), context ${ctx}, ${accel}.`;
  return {
    schema: "crestmont.model-recommendation/1", ok, tier, summary,
    model: pick?.model ?? null, quantization: pick?.quantization ?? null, license: pick?.license ?? null,
    contextTokens: ctx,
    ollama: { numParallel, flashAttention: accel !== "cpu-only" && accel !== "none", kvCacheType, keepAlive: "60m", contextLength: ctx },
    jobLimits, acceleration: accel, alternatives, reasons: pick ? [...reasons, pick.note] : reasons, warnings, blockers, modelChoiceBlockers,
    sources: pick?.sources ?? [],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { process.stderr.write("usage: node windows/select-model.ts <hardware.json>\n"); process.exit(2); }
  const rec = selectModel(parseHardwareBytes(readFileSync(file)));
  process.stdout.write(JSON.stringify(rec, null, 2) + "\n");
  process.exit(rec.ok ? 0 : 3);
}
