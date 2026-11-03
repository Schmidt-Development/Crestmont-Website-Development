// The path router, including the trailing wildcard the AI Build preview needs.
//
// A preview page references its assets the way any website does -- `href="assets/site.css"` -- so serving a stored
// revision means matching paths of unknown depth. The wildcard exists for that and nothing else: it must not widen
// what the ordinary ":param" routes accept, and it must not let a path escape the route it was matched under.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Router } from "../src/lib/router.ts";

const ok = () => new Response("ok");
const r = new Router();
r.get("/staff/builds", ok);
r.get("/staff/builds/:id", ok);
r.get("/staff/builds/:id/rev/:rev/*", ok);
r.post("/staff/builds/:id/pause", ok);

test("[ROUTER] exact routes still match on segment count and validated params", () => {
  assert.equal(r.match("GET", "/staff/builds")?.pattern, "/staff/builds");
  assert.deepEqual(r.match("GET", "/staff/builds/bld_1")?.params, { id: "bld_1" });
  assert.equal(r.match("GET", "/staff/builds/bld_1/extra"), null, "a longer path does not fall into a shorter route");
  assert.equal(r.match("GET", "/staff/builds/bld_1/pause"), null, "method still matters");
  assert.equal(r.match("POST", "/staff/builds/bld_1/pause")?.pattern, "/staff/builds/:id/pause");
  assert.equal(r.match("GET", "/staff/builds/a%2Fb"), null, "a param may not smuggle a slash through an escape");
  assert.equal(r.match("GET", "/staff/builds/..")?.params.id, "..", "the router passes '..' through; handlers validate it");
  assert.equal(r.match("HEAD", "/staff/builds")?.pattern, "/staff/builds", "HEAD matches a GET route");
});

test("[ROUTER] a trailing wildcard captures the remaining path, at any depth", () => {
  const one = r.match("GET", "/staff/builds/bld_1/rev/1-0/index.html");
  assert.deepEqual(one?.params, { id: "bld_1", rev: "1-0", "*": "index.html" });
  const deep = r.match("GET", "/staff/builds/bld_1/rev/1-0/assets/img/hero.png");
  assert.equal(deep?.params["*"], "assets/img/hero.png", "depth is not fixed, which is the whole point");
  assert.equal(deep?.params.id, "bld_1", "earlier params still bind");
  const dotted = r.match("GET", "/staff/builds/bld_1/rev/1-0/.crestmont/screenshots/home-desktop.png");
  assert.equal(dotted?.params["*"], ".crestmont/screenshots/home-desktop.png", "the review cycle's screenshots live under a dot directory");
});

test("[ROUTER] the wildcard needs at least one segment and never swallows its own prefix", () => {
  assert.equal(r.match("GET", "/staff/builds/bld_1/rev/1-0"), null, "'/a/*' does not match '/a'");
  assert.equal(r.match("GET", "/staff/builds/bld_1/rev"), null);
  assert.equal(r.match("GET", "/staff/builds/bld_1")?.pattern, "/staff/builds/:id", "an exact route still wins over the wildcard route");
});

test("[ROUTER] a wildcard does not decode its way out of the route", () => {
  // Percent-encoded traversal decodes to "..", which the router passes on: the handler's allowlist refuses it.
  // What matters here is that the captured value cannot change WHICH route matched.
  const esc = r.match("GET", "/staff/builds/bld_1/rev/1-0/%2e%2e/%2e%2e/secret");
  assert.equal(esc?.pattern, "/staff/builds/:id/rev/:rev/*");
  assert.equal(esc?.params["*"], "../../secret", "decoded, and handed to the handler to refuse");
  assert.equal(r.match("GET", "/staff/builds/bld_1/rev/1-0/%ZZ"), null, "an undecodable segment matches nothing");
});
