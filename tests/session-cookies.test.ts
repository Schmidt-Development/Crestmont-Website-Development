// CREST-GAP-086: __Host- cookie names over HTTPS, and legacy names still accepted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, TEST_PASSWORD } from "./support/app.ts";
import { handle } from "../src/app/app.ts";

test("[SEC-002] over HTTPS the CSRF and session cookies use the __Host- prefix with Secure and Path=/ (CREST-GAP-086)", async () => {
  const { env, db } = await createTestApp({ APP_URL: "https://crestmont.test" });
  const staff = await createStaff(db, "sales");
  const page = await handle(new Request("https://crestmont.test/login"), env);
  const csrfCookie = page.headers.getSetCookie().find((c) => c.startsWith("__Host-cm_csrf="));
  assert.ok(csrfCookie, "CSRF cookie is __Host- prefixed");
  assert.match(csrfCookie!, /;\s*Secure/i);
  assert.match(csrfCookie!, /;\s*Path=\//i);
  assert.doesNotMatch(csrfCookie!, /Domain=/i);
  const csrf = decodeURIComponent(csrfCookie!.split(";")[0].split("=")[1]);
  const res = await handle(new Request("https://crestmont.test/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://crestmont.test", cookie: `__Host-cm_csrf=${csrf}` },
    body: new URLSearchParams({ _csrf: csrf, email: staff.email, password: TEST_PASSWORD }).toString() }), env);
  assert.equal(res.status, 303);
  const session = res.headers.getSetCookie().find((c) => c.startsWith("__Host-cm_session="));
  assert.ok(session, "session cookie is __Host- prefixed");
  assert.match(session!, /HttpOnly/i);
  // A session held under the legacy name (issued before this change) still works.
  const token = decodeURIComponent(session!.split(";")[0].split("=")[1]);
  const legacy = await handle(new Request("https://crestmont.test/staff", { headers: { cookie: `cm_session=${token}` } }), env);
  assert.equal(legacy.status, 200, "legacy cookie name is still read");
});
