// SEC-10: does the DEPLOYED site actually serve HTTPS correctly?
//
// Everything about transport security was asserted in code and nothing was ever checked against the live
// endpoint: hstsValue() is unit-tested, but no workflow had looked at a certificate, a TLS version or a
// redirect. This is the read-only check that does, from CI, with no credential and nothing to buy.
//
// What it asserts, and why each one is a real failure rather than a preference:
//   · the certificate verifies against the system trust store (curl does the verification)
//   · it is not expiring within 14 days — Cloudflare renews automatically, so a short remaining life means
//     renewal is NOT happening and the site goes dark on expiry
//   · TLS 1.2 and 1.3 both complete
//   · TLS 1.0 and 1.1 are refused (PCI DSS and every current baseline; Cloudflare's default minimum is 1.0,
//     which is a setting the Owner can raise, so this check is what tells them it needs raising)
//   · the live response carries Strict-Transport-Security with max-age >= 1 year
//   · http:// does not serve the site: it must redirect to https:// (301/302/307/308) or refuse
//
// Usage: node --no-warnings scripts/tls-check.ts <https url> [--json <file>]
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface TlsProbe { label: string; ok: boolean; detail: string; fatal: boolean }

/** Minimum remaining certificate life. Cloudflare renews well before this, so less means renewal is stuck. */
export const MIN_CERT_DAYS = 14;
/** One year, the HSTS floor preload requires and the floor this platform sets by default. */
export const MIN_HSTS_MAX_AGE = 31_536_000;

/** `max-age` from a Strict-Transport-Security header, or null when absent or unparsable. */
export function hstsMaxAge(header: string | null | undefined): number | null {
  const m = /(?:^|[;,\s])max-age\s*=\s*"?(\d+)"?/i.exec(header ?? "");
  return m ? Number(m[1]) : null;
}

/** Whole days from `now` until an OpenSSL `notAfter` date, or null when it cannot be read. */
export function certDaysLeft(notAfter: string, now = new Date()): number | null {
  const t = Date.parse(notAfter.replace(/^notAfter=/, "").trim());
  return Number.isFinite(t) ? Math.floor((t - now.getTime()) / 86_400_000) : null;
}

/**
 * Turns the gathered facts into pass/fail. Kept pure so the POLICY is unit-testable without a network:
 * the thin main below only collects the facts and hands them here.
 */
export interface TlsFacts {
  verifiedCert: boolean; verifyDetail: string;
  daysLeft: number | null;
  tls12: boolean; tls13: boolean; tls10Refused: boolean; tls11Refused: boolean;
  hsts: string | null;
  httpStatus: number | null; httpLocation: string | null;
}

export function evaluate(f: TlsFacts, now = new Date()): TlsProbe[] {
  void now;
  const out: TlsProbe[] = [];
  const add = (label: string, ok: boolean, detail: string, fatal = true) => out.push({ label, ok, detail, fatal });

  add("certificate verifies", f.verifiedCert, f.verifiedCert ? "trusted chain" : `verification failed: ${f.verifyDetail}`);
  add("certificate not expiring", f.daysLeft !== null && f.daysLeft >= MIN_CERT_DAYS,
    f.daysLeft === null ? "could not read notAfter" : `${f.daysLeft} day(s) left (minimum ${MIN_CERT_DAYS})`);
  add("TLS 1.2 accepted", f.tls12, f.tls12 ? "handshake completed" : "handshake failed");
  add("TLS 1.3 accepted", f.tls13, f.tls13 ? "handshake completed" : "handshake failed");
  // Not fatal: Cloudflare's default minimum version is 1.0 and raising it is an Owner setting in the
  // dashboard, not something this repository deploys. Reported so the Owner knows it is still to do.
  add("TLS 1.0 refused", f.tls10Refused, f.tls10Refused ? "refused" : "ACCEPTED — raise the minimum TLS version to 1.2 in Cloudflare (SSL/TLS → Edge Certificates)", false);
  add("TLS 1.1 refused", f.tls11Refused, f.tls11Refused ? "refused" : "ACCEPTED — raise the minimum TLS version to 1.2 in Cloudflare (SSL/TLS → Edge Certificates)", false);

  const age = hstsMaxAge(f.hsts);
  add("HSTS on the live response", age !== null && age >= MIN_HSTS_MAX_AGE,
    age === null ? `no usable Strict-Transport-Security header (${f.hsts ?? "absent"})` : `max-age=${age} (minimum ${MIN_HSTS_MAX_AGE})`);

  const redirected = f.httpStatus !== null && [301, 302, 307, 308].includes(f.httpStatus) && /^https:/i.test(f.httpLocation ?? "");
  const refused = f.httpStatus === null;
  add("plain http does not serve the site", redirected || refused,
    refused ? "no plain-http listener" : redirected ? `HTTP ${f.httpStatus} → ${f.httpLocation}` : `HTTP ${f.httpStatus} served over plain http (expected a redirect to https)`);
  return out;
}

function sh(cmd: string, args: string[], input?: string): { ok: boolean; out: string } {
  try { return { ok: true, out: execFileSync(cmd, args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 }) }; }
  catch (e) { const err = e as { stdout?: string; stderr?: string }; return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` }; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.argv[2];
  if (!url || !/^https:\/\//.test(url)) { console.error("usage: tls-check.ts <https url> [--json <file>]"); process.exit(2); }
  const host = new URL(url).host;
  const hostname = new URL(url).hostname;

  const verify = sh("curl", ["-sS", "-o", "/dev/null", "-w", "%{ssl_verify_result}", "--max-time", "20", url]);
  const notAfter = sh("sh", ["-c", `echo | openssl s_client -servername ${hostname} -connect ${host} 2>/dev/null | openssl x509 -noout -enddate`]);
  const tlsAt = (flag: string) => sh("curl", ["-sS", "-o", "/dev/null", flag, "--max-time", "20", url]).ok;
  const head = sh("curl", ["-sSI", "--max-time", "20", url]);
  const hsts = /^strict-transport-security:(.*)$/im.exec(head.out)?.[1]?.trim() ?? null;
  const plain = sh("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code} %{redirect_url}", "--max-time", "20", `http://${host}`]);
  const [code, location] = plain.ok ? plain.out.trim().split(" ") : ["", ""];

  const probes = evaluate({
    verifiedCert: verify.ok && verify.out.trim() === "0", verifyDetail: verify.out.trim().slice(0, 200),
    daysLeft: notAfter.ok ? certDaysLeft(notAfter.out) : null,
    tls12: tlsAt("--tlsv1.2"), tls13: tlsAt("--tlsv1.3"),
    tls10Refused: !sh("curl", ["-sS", "-o", "/dev/null", "--tlsv1.0", "--tls-max", "1.0", "--max-time", "20", url]).ok,
    tls11Refused: !sh("curl", ["-sS", "-o", "/dev/null", "--tlsv1.1", "--tls-max", "1.1", "--max-time", "20", url]).ok,
    hsts,
    httpStatus: code && code !== "000" ? Number(code) : null, httpLocation: location || null,
  });

  for (const p of probes) {
    const tag = p.ok ? "PASS" : p.fatal ? "FAIL" : "WARN";
    console.log(`${tag} ${p.label} — ${p.detail}`);
    if (!p.ok) console.log(`::${p.fatal ? "error" : "warning"} title=TLS ${p.label}::${p.detail}`);
  }
  const jsonArg = process.argv.indexOf("--json");
  if (jsonArg > 0 && process.argv[jsonArg + 1]) writeFileSync(process.argv[jsonArg + 1], JSON.stringify({ url, checkedAt: new Date().toISOString(), probes }, null, 2));
  const failed = probes.filter((p) => !p.ok && p.fatal);
  console.log(`${probes.filter((p) => p.ok).length}/${probes.length} transport checks passed${failed.length ? `; ${failed.length} fatal` : ""}.`);
  process.exit(failed.length ? 1 : 0);
}
