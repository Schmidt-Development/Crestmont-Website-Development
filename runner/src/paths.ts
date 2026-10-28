// Filesystem confinement for paths the runner hands to child processes (tar archives, git working trees, export
// directories). Every such path must stay inside an authorized root (the job workspace or RUNNER_WORKSPACES): no
// traversal, no unrelated absolute path, and no symlink that leads out of the root.

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export class PathEscapeError extends Error {
  constructor(message: string) { super(message); this.name = "PathEscapeError"; }
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

/**
 * Resolve `target` (absolute, or relative to `root`) and return it only when it stays inside `root`, both lexically
 * and after resolving symlinks of its nearest existing ancestor. Throws PathEscapeError otherwise.
 */
export function resolveWithin(root: string, target: string): string {
  if (typeof root !== "string" || typeof target !== "string" || root.includes("\0") || target.includes("\0")) throw new PathEscapeError("path contains a NUL byte");
  if (!path.isAbsolute(root)) throw new PathEscapeError(`authorized root must be absolute: ${root.slice(0, 200)}`);
  const r = path.resolve(root);
  const t = path.resolve(r, target);
  if (!inside(r, t)) throw new PathEscapeError(`path ${t.slice(0, 200)} is outside ${r.slice(0, 200)}`);
  if (existsSync(r)) {
    const realRoot = realpathSync(r);
    let cur = t;
    while (!existsSync(cur) && cur !== path.dirname(cur)) cur = path.dirname(cur);
    if (!inside(realRoot, realpathSync(cur))) throw new PathEscapeError(`path ${t.slice(0, 200)} leaves ${r.slice(0, 200)} through a symbolic link`);
  }
  return t;
}

/** A single path segment safe to join under a root (no separators, traversal or control characters). */
export const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,159}$/;
export function assertSafeSegment(s: string, what: string): string {
  if (typeof s !== "string" || !SAFE_SEGMENT.test(s) || s.includes("..")) throw new PathEscapeError(`invalid ${what}: ${String(s).slice(0, 80)}`);
  return s;
}
