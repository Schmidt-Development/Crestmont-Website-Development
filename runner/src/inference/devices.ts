// GPU device registration (Founder directive, 2026-11-02, Phase 6).
//
// A device is a GPU plus the model server pinned to it. Ollama chooses its GPUs at process start
// (CUDA_VISIBLE_DEVICES), not per request, so a request cannot pick a GPU on a server that owns two: addressing a
// device means addressing its server, which makes one endpoint per device the registration unit. Dispatch between
// registered devices is in fleet.ts; this module only says what a device is and how it is configured, so that the
// configuration loader does not have to pull in the scheduler to read a list.

import type { GpuEndpoint } from "./scheduler.ts";

/** One GPU and the model server that owns it. `index` is the host's device index (CUDA_VISIBLE_DEVICES). */
export interface GpuDevice extends GpuEndpoint {
  /** Usable VRAM in MB (0 = unknown; the scheduler then keeps one model resident). */
  vramTotalMb: number;
}

/**
 * Parse INFERENCE_DEVICES: a comma-separated list of `index=baseUrl[#vramMb]`, e.g.
 *   "0=http://host.docker.internal:11434/v1#32563,1=http://host.docker.internal:11435/v1#32563"
 * Empty or unset means one device built from the single-GPU settings the installer already writes, so an existing
 * installation keeps exactly its current behaviour and nothing has to be reconfigured. A malformed list is an error
 * at startup rather than a silently dropped GPU.
 */
export function parseDevices(spec: string | undefined, fallback: { baseUrl: string; vramTotalMb: number }): GpuDevice[] {
  const text = (spec ?? "").trim();
  if (!text) return [{ index: 0, baseUrl: fallback.baseUrl, vramTotalMb: fallback.vramTotalMb, label: "gpu0" }];
  const out: GpuDevice[] = [];
  for (const entry of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d{1,2})=([^#\s]+)(?:#(\d{1,7}))?$/.exec(entry);
    if (!m) throw new Error(`INFERENCE_DEVICES: "${entry.slice(0, 60)}" is not index=baseUrl[#vramMb]`);
    const index = Number(m[1]);
    if (out.some((d) => d.index === index)) throw new Error(`INFERENCE_DEVICES: device ${index} is listed twice`);
    let url: URL;
    try { url = new URL(m[2]); } catch { throw new Error(`INFERENCE_DEVICES: device ${index} has an invalid base URL`); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`INFERENCE_DEVICES: device ${index} must use http or https`);
    if (out.some((d) => d.baseUrl === m[2])) throw new Error(`INFERENCE_DEVICES: ${m[2]} is listed for two devices; one model server owns one device`);
    out.push({ index, baseUrl: m[2], vramTotalMb: m[3] ? Number(m[3]) : fallback.vramTotalMb, label: `gpu${index}` });
  }
  if (!out.length) throw new Error("INFERENCE_DEVICES is set but lists no device");
  return out.sort((a, b) => a.index - b.index);
}
