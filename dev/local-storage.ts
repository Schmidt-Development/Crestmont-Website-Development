// Development-only private storage on local disk. Never used in staging/production (R2 there).
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import type { StorageAdapter } from "../src/adapters/storage.ts";

export class LocalDiskStorage implements StorageAdapter {
  readonly kind = "local-disk" as const;
  private root: string;
  constructor(root: string) { this.root = resolve(root); mkdirSync(this.root, { recursive: true }); }
  private path(key: string) {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + "/")) throw new Error("Invalid storage key");
    return p;
  }
  async put(key: string, data: Uint8Array, contentType: string) {
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
    writeFileSync(p + ".meta", contentType);
  }
  async get(key: string) {
    const p = this.path(key);
    if (!existsSync(p)) return null;
    const body = readFileSync(p);
    return { body: new Uint8Array(body), size: body.length, contentType: existsSync(p + ".meta") ? readFileSync(p + ".meta", "utf8") : "application/octet-stream" };
  }
  async delete(key: string) { const p = this.path(key); rmSync(p, { force: true }); rmSync(p + ".meta", { force: true }); }
}
