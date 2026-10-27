import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "./support/app.ts";
import { passwordProblems } from "../src/lib/auth-crypto.ts";
import { redact } from "../src/services/monitoring.ts";
import { guardFetch, egressAllowed, allowEgressHost, EgressBlockedError } from "../src/lib/egress.ts";

const sha1 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();

test("[SEC-007] F-06 breached-password check: k-anonymity range lookup blocks breached passwords, fails open with a security event", async () => {
  const breached = "Tr0ub4dor&3-breached-example";
  const hash = await sha1(breached);
  const seen: string[] = [];
  let mode: "hit" | "miss" | "down" = "hit";
  const fakeFetch = (async (url: string | URL) => {
    seen.push(String(url));
    if (mode === "down") throw new Error("connect ECONNREFUSED");
    const lines = ["0018A45C4D1DEF81644B54AB7F969B88D65:1", mode === "hit" ? `${hash.slice(5)}:42` : "00D4F6E8FA6EECAD2A3AA415EEC418D38EC:0"];
    return new Response(lines.join("\r\n"), { status: 200 });
  }) as typeof fetch;
  const t = await createTestApp({ PASSWORD_BREACH_CHECK: "on", overrides: { fetch: fakeFetch } });
  const register = (email: string, password: string) => t.client().post("/register", { name: "Breach Test", organization: "Breach Co", email, password, terms: "1" });

  const r1 = await register("b1@example.com", breached);
  assert.equal(r1.status, 400);
  assert.match(await r1.text(), /appeared in a known data breach/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], `https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`, "only the 5-character SHA-1 prefix leaves the platform");
  assert.doesNotMatch(seen[0], new RegExp(hash.slice(5)));
  assert.equal((await t.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE email = 'b1@example.com'`).first<{ n: number }>())!.n, 0);

  mode = "miss";
  assert.equal((await register("b2@example.com", breached)).status, 200, "not in the range response: accepted");
  mode = "down";
  assert.equal((await register("b3@example.com", breached)).status, 200, "service unreachable: fail open");
  assert.ok(await t.db.prepare(`SELECT 1 FROM security_events WHERE kind = 'breach_check_unavailable'`).first(), "outage recorded");

  // Default: off in development (no outbound call at all), on elsewhere.
  const calls: string[] = [];
  const dev = await createTestApp({ overrides: { fetch: (async (u: string) => { calls.push(u); return new Response(""); }) as typeof fetch } });
  await dev.client().post("/register", { name: "Dev", organization: "Dev Co", email: "d@example.com", password: breached, terms: "1" });
  assert.equal(calls.length, 0);
});

test("[SEC-007] F-06 local policy rejects common long passwords and patterns", () => {
  for (const pw of ["password1234", "Password2024!", "crestmont2026", "123456789012345", "correcthorsebatterystaple", "letmein123456"]) assert.ok(passwordProblems(pw).includes("Password is too common"), pw);
  for (const pw of ["gold-shield-harbor-river", "Tz8#kq2!Lm4v"]) assert.deepEqual(passwordProblems(pw), [], pw);
});

test("[SEC-007] F-13 error redaction removes emails, phone numbers and long card-like numbers but keeps timestamps and ids", () => {
  const out = redact("user jo.doe@example.com phone +1 (517) 555-0134 at 2026-10-27T08:00:00Z card 4242 4242 4242 4242 id 12345 HTTP 500 key sk_test_abc123");
  assert.doesNotMatch(out, /jo\.doe|555-0134|4242 4242|sk_test_abc123/);
  assert.match(out, /2026-10-27T08:00:00Z/);
  assert.match(out, /id 12345 HTTP 500/);
});

test("[SEC-002] F-11 egress allowlist: only fixed provider hosts over https; validated probe hosts allowed only for the call", async () => {
  const hits: string[] = [];
  const f = guardFetch((async (u: string) => { hits.push(String(u)); return new Response("ok"); }) as typeof fetch);
  assert.equal(await (await f("https://api.stripe.com/v1/balance")).text(), "ok");
  for (const bad of ["https://evil.example/x", "http://api.stripe.com/v1", "https://169.254.169.254/latest/meta-data", "https://api.stripe.com.evil.example/", "not a url"]) {
    await assert.rejects(f(bad), EgressBlockedError, bad);
  }
  assert.equal(hits.length, 1);
  assert.equal(egressAllowed("https://crestmont-platform-staging.example.workers.dev/api/health"), false);
  const release = allowEgressHost("crestmont-platform-staging.example.workers.dev");
  assert.equal(egressAllowed("https://crestmont-platform-staging.example.workers.dev/api/health"), true);
  release();
  assert.equal(egressAllowed("https://crestmont-platform-staging.example.workers.dev/api/health"), false);

  // The deployed Worker entry point installs the guard on the global fetch.
  await import("../src/worker.ts");
  await assert.rejects(fetch("https://example.org/"), EgressBlockedError);
});
