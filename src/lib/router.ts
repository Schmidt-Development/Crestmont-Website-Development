// Tiny path router with :params. Route handlers receive a RequestContext.
import type { AppContext } from "../app/context.ts";

export type Handler = (ctx: AppContext, params: Record<string, string>) => Promise<Response> | Response;

interface Route { method: string; parts: string[]; handler: Handler }

export class Router {
  private routes: Route[] = [];

  on(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, parts: split(pattern), handler });
    return this;
  }
  get(p: string, h: Handler) { return this.on("GET", p, h); }
  post(p: string, h: Handler) { return this.on("POST", p, h); }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = split(pathname);
    for (const r of this.routes) {
      if (r.method !== method && !(method === "HEAD" && r.method === "GET")) continue;
      if (r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < r.parts.length; i++) {
        const rp = r.parts[i];
        if (rp.startsWith(":")) {
          let val: string;
          try { val = decodeURIComponent(parts[i]); } catch { ok = false; break; }
          if (!/^[A-Za-z0-9_.-]{1,120}$/.test(val)) { ok = false; break; }
          params[rp.slice(1)] = val;
        } else if (rp !== parts[i]) { ok = false; break; }
      }
      if (ok) return { handler: r.handler, params };
    }
    return null;
  }

  /** True if any route exists for the path regardless of method (used for 405). */
  hasPath(pathname: string): boolean {
    return this.routes.some((r) => this.match(r.method, pathname)?.handler === r.handler);
  }
}

function split(p: string): string[] {
  return p.replace(/\/+$/, "").split("/").filter(Boolean);
}
