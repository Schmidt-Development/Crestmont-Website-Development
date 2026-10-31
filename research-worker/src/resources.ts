// Resource snapshot for the dashboard and the benchmark: CPU (sampled), RAM, free disk on the data drive, and GPU
// via nvidia-smi when present (free with the NVIDIA driver). Nothing here fails the worker.
import { cpus, totalmem, freemem } from "node:os";
import { statfsSync } from "node:fs";
import { execFile } from "node:child_process";

let last = cpus().map((c) => c.times);
export function cpuPercent(): number {
  const now = cpus().map((c) => c.times);
  let idle = 0, total = 0;
  now.forEach((t, i) => {
    const p = last[i] ?? t;
    const d = { user: t.user - p.user, nice: t.nice - p.nice, sys: t.sys - p.sys, idle: t.idle - p.idle, irq: t.irq - p.irq };
    idle += d.idle; total += d.user + d.nice + d.sys + d.idle + d.irq;
  });
  last = now;
  return total ? Math.round((1 - idle / total) * 100) : 0;
}

export function gpu(): Promise<{ utilPct: number; memUsedMb: number; memTotalMb: number; name: string } | null> {
  return new Promise((resolve) => {
    execFile("nvidia-smi", ["--query-gpu=utilization.gpu,memory.used,memory.total,name", "--format=csv,noheader,nounits"], { timeout: 5000, windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      const [u, used, total, ...name] = out.split("\n")[0].split(",").map((x) => x.trim());
      resolve(u ? { utilPct: Number(u), memUsedMb: Number(used), memTotalMb: Number(total), name: name.join(",") } : null);
    });
  });
}

export async function snapshot(dataDir: string) {
  let diskFreeGb: number | null = null;
  try { const s = statfsSync(dataDir); diskFreeGb = Math.round((s.bavail * s.bsize) / 1e9); } catch { /* unknown */ }
  return { cpuPct: cpuPercent(), ramUsedGb: Math.round(((totalmem() - freemem()) / 1e9) * 10) / 10, ramTotalGb: Math.round((totalmem() / 1e9) * 10) / 10, rssMb: Math.round(process.memoryUsage().rss / 1e6), diskFreeGb, gpu: await gpu() };
}
