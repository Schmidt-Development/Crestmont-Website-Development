// SEC-002, and directive item SEC-10: the transport-security POLICY, tested without a network. scripts/tls-check.ts collects the facts
// from curl and openssl against the deployed site; evaluate() turns them into pass/fail, and that is the part
// worth pinning — everything about transport security used to be asserted in code and never checked against
// a live endpoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, hstsMaxAge, certDaysLeft, MIN_CERT_DAYS, MIN_HSTS_MAX_AGE } from "../scripts/tls-check.ts";

const healthy = {
  verifiedCert: true, verifyDetail: "",
  daysLeft: 70,
  tls12: true, tls13: true, tls10Refused: true, tls11Refused: true,
  hsts: "max-age=63072000; includeSubDomains",
  httpStatus: 301, httpLocation: "https://example.test/",
};
const probe = (f: Partial<typeof healthy>) => evaluate({ ...healthy, ...f });
const of = (f: Partial<typeof healthy>, label: string) => probe(f).find((p) => p.label === label)!;

test("[SEC-002] a correctly served site passes every transport check", () => {
  const probes = probe({});
  assert.deepEqual(probes.filter((p) => !p.ok), [], "a healthy endpoint has nothing to report");
  assert.ok(probes.length >= 8, "certificate, expiry, two TLS versions accepted, two refused, HSTS, plain http");
});

test("[SEC-002] an untrusted or expiring certificate fails, and an expiry that cannot be read is not a pass", () => {
  assert.equal(of({ verifiedCert: false, verifyDetail: "60" }, "certificate verifies").ok, false);
  assert.equal(of({ daysLeft: MIN_CERT_DAYS - 1 }, "certificate not expiring").ok, false, "renewal is stuck");
  assert.equal(of({ daysLeft: MIN_CERT_DAYS }, "certificate not expiring").ok, true, "the boundary passes");
  // Unknown must never read as fine: that is how a stuck renewal would go unnoticed.
  const unknown = of({ daysLeft: null }, "certificate not expiring");
  assert.equal(unknown.ok, false);
  assert.match(unknown.detail, /could not read/);
});

test("[SEC-002] TLS 1.2 and 1.3 must work; 1.0 and 1.1 accepted is a warning naming the Cloudflare setting", () => {
  for (const k of ["tls12", "tls13"] as const) {
    const p = probe({ [k]: false }).find((x) => !x.ok)!;
    assert.ok(p.fatal, `${k} failing is fatal`);
  }
  // Raising the minimum version is an Owner setting in the Cloudflare dashboard, not something this
  // repository deploys, so it is reported rather than failing a deploy that cannot fix it.
  for (const k of ["tls10Refused", "tls11Refused"] as const) {
    const p = probe({ [k]: false }).find((x) => !x.ok)!;
    assert.equal(p.fatal, false);
    assert.match(p.detail, /Cloudflare/, "the warning says where to change it");
  }
});

test("[SEC-002] HSTS must be present on the live response with at least a year", () => {
  assert.equal(hstsMaxAge("max-age=63072000; includeSubDomains"), 63072000);
  assert.equal(hstsMaxAge('max-age="31536000"'), 31536000, "a quoted value is still a value");
  assert.equal(hstsMaxAge("includeSubDomains"), null);
  assert.equal(hstsMaxAge(null), null);
  assert.equal(of({ hsts: null }, "HSTS on the live response").ok, false, "absent is a failure, not a pass");
  assert.equal(of({ hsts: `max-age=${MIN_HSTS_MAX_AGE - 1}` }, "HSTS on the live response").ok, false);
  assert.equal(of({ hsts: `max-age=${MIN_HSTS_MAX_AGE}` }, "HSTS on the live response").ok, true);
});

test("[SEC-002] plain http must redirect to https or not answer at all", () => {
  const label = "plain http does not serve the site";
  assert.equal(of({ httpStatus: null, httpLocation: null }, label).ok, true, "nothing listening is fine");
  for (const s of [301, 302, 307, 308]) assert.equal(of({ httpStatus: s, httpLocation: "https://example.test/" }, label).ok, true);
  assert.equal(of({ httpStatus: 200, httpLocation: null }, label).ok, false, "serving the site over plain http");
  // A redirect that stays on http is the mistake this catches, not a pass.
  assert.equal(of({ httpStatus: 301, httpLocation: "http://example.test/" }, label).ok, false);
});

test("[SEC-002] certDaysLeft reads OpenSSL's notAfter line", () => {
  const now = new Date("2026-11-05T00:00:00Z");
  assert.equal(certDaysLeft("notAfter=Jan 20 12:00:00 2027 GMT", now), 76);
  assert.equal(certDaysLeft("Jan 20 12:00:00 2027 GMT", now), 76, "with or without the prefix");
  assert.equal(certDaysLeft("not a date", now), null);
});
