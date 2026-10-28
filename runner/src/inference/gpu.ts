// GPU telemetry. The runner runs in a Linux container on Docker Desktop and cannot query the Windows GPU itself, so
// the host writes it: Write-GpuTelemetry.ps1 (a scheduled task on Node 1) runs
//   nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu --format=csv,noheader,nounits
// every minute and saves JSON that is mounted read-only into the runner. A missing, unreadable or stale file means
// "not reported": the runner never invents a VRAM or utilization figure.

import { readFileSync, statSync } from "node:fs";

export interface GpuSample { name: string | null; driver: string | null; vramTotalMb: number | null; vramUsedMb: number | null; utilPercent: number | null; at: string; source: string }

export const GPU_SOURCE = "nvidia-smi (host sampler)";
const FRESH_MS = 3 * 60_000;

export function readGpuTelemetry(file: string, now = Date.now()): GpuSample | null {
  try {
    if (statSync(file).size > 64 * 1024) return null;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const at = typeof raw.at === "string" && !Number.isNaN(Date.parse(raw.at)) ? raw.at : null;
    if (!at || now - Date.parse(at) > FRESH_MS || Date.parse(at) - now > 60_000) return null;
    const n = (v: unknown, max: number) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : null;
    const s = (v: unknown) => typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : null;
    return { name: s(raw.name), driver: s(raw.driver), vramTotalMb: n(raw.memoryTotalMb, 1_000_000), vramUsedMb: n(raw.memoryUsedMb, 1_000_000), utilPercent: n(raw.utilizationPercent, 100), at, source: GPU_SOURCE };
  } catch { return null; }
}

/** Parse one nvidia-smi CSV line (the sampler's format) — shared with the tests of the PowerShell sampler. */
export function parseNvidiaSmiCsv(line: string): Omit<GpuSample, "at" | "source"> | null {
  const p = line.split(",").map((x) => x.trim());
  if (p.length < 5) return null;
  const n = (v: string) => /^\d+(\.\d+)?$/.test(v) ? Number(v) : null;
  return { name: p[0] || null, driver: p[1] || null, vramTotalMb: n(p[2]), vramUsedMb: n(p[3]), utilPercent: n(p[4]) };
}
