// Tiny path router with :params. Route handlers receive a RequestContext.
import type { AppContext } from "../app/context.ts";

export type Handler = (ctx: AppContext, params: Record<string, string>) => Promise<Response> | Response;

interface Route { method: string; pattern: string; parts: string[]; handler: Handler }

export class Router {
  private routes: Route[] = [];

  on(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, pattern, parts: split(pattern), handler });
    return this;
  }
  get(p: string, h: Handler) { return this.on("GET", p, h); }
  post(p: string, h: Handler) { return this.on("POST", p, h); }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string>; pattern: string } | null {
    const parts = split(pathname);
    for (const r of this.routes) {
      if (r.method !== method && !(method === "HEAD" && r.method === "GET")) continue;
      // A pattern whose last segment is "*" captures the remaining segments as params["*"], joined with "/". Only a
      // trailing "*" is a wildcard and it must match at least one segment, so "/a/*" never matches "/a" itself. The
      // AI Build preview needs this: its generated pages reference assets through ordinary relative paths. The
      // captured value is validated by the handler against its own allowlist and never used to build a file path.
      const wild = r.parts.length > 0 && r.parts[r.parts.length - 1] === "*";
      if (wild ? parts.length < r.parts.length : r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < r.parts.length; i++) {
        const rp = r.parts[i];
        if (wild && i === r.parts.length - 1) {
          let rest: string;
          try { rest = parts.slice(i).map((s) => decodeURIComponent(s)).join("/"); } catch { ok = false; break; }
          if (rest.includes("\0") || rest.length > 400) { ok = false; break; }
          params["*"] = rest;
        } else if (rp.startsWith(":")) {
          let val: string;
          try { val = decodeURIComponent(parts[i]); } catch { ok = false; break; }
          if (!/^[A-Za-z0-9_.-]{1,120}$/.test(val)) { ok = false; break; }
          params[rp.slice(1)] = val;
        } else if (rp !== parts[i]) { ok = false; break; }
      }
      if (ok) return { handler: r.handler, params, pattern: r.pattern };
    }
    return null;
  }

  /** Every registered route in registration (= match) order. Used by the route security matrix (AUTH-007). */
  list(): { method: string; pattern: string }[] {
    return this.routes.map((r) => ({ method: r.method, pattern: r.pattern }));
  }

  /** True if any route exists for the path regardless of method (used for 405). */
  hasPath(pathname: string): boolean {
    return this.routes.some((r) => this.match(r.method, pathname)?.handler === r.handler);
  }
}

function split(p: string): string[] {
  return p.replace(/\/+$/, "").split("/").filter(Boolean);
}
