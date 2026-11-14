// Amazon SES (second email provider next to Resend) and the SNS event webhook it reports through.
//
// Sending: SES v2 HTTPS API, POST https://email.<SES_REGION>.amazonaws.com/v2/email/outbound-emails, signed with AWS
// Signature Version 4 (service "ses"). The signer is implemented here on WebCrypto (Workers and Node 22 alike) instead
// of pulling in aws4fetch, because the platform root has no runtime dependencies or lockfile (see ci.yml's dependency
// audit). Algorithm: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
//
// Events: SES publishes to one shared SNS topic (SES_SNS_TOPIC_ARN); SNS POSTs to /api/webhooks/ses. Every message is
// verified per https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html (SignatureVersion 1 =
// SHA1withRSA, 2 = SHA256withRSA, certificate only from https://sns.<region>.amazonaws.com/*.pem).
//
// Provider selection (src/app/app.ts): EMAIL_PROVIDER = "ses" selects SES; missing, empty or any other value keeps
// Resend. SES is never chosen implicitly.

const enc = new TextEncoder();

export type EmailProviderName = "resend" | "ses";

/** EMAIL_PROVIDER → provider. Only the exact value "ses" (any case, trimmed) selects SES; everything else is Resend. */
export function emailProvider(env: { EMAIL_PROVIDER?: string }): EmailProviderName {
  return (env.EMAIL_PROVIDER ?? "").trim().toLowerCase() === "ses" ? "ses" : "resend";
}

export interface SesConfig { accessKeyId: string; secretAccessKey: string; region: string; configurationSet: string }
export interface SesEnv {
  SES_ACCESS_KEY_ID?: string; SES_SECRET_ACCESS_KEY?: string; SES_REGION?: string; SES_CONFIGURATION_SET?: string;
  SES_FROM?: string; SES_SNS_TOPIC_ARN?: string;
}
/** Variables SES sending needs (SES_FROM is optional: it defaults to EMAIL_FROM). */
export const SES_SEND_VARS = ["SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY", "SES_REGION", "SES_CONFIGURATION_SET"] as const;
/** Every SES variable, for presence reporting (never values). */
export const SES_VARS = [...SES_SEND_VARS, "SES_FROM", "SES_SNS_TOPIC_ARN"] as const;

/** The complete sending config, or the names of the missing variables. */
export function sesConfig(env: SesEnv): { ok: true; config: SesConfig } | { ok: false; missing: string[] } {
  const v = (k: (typeof SES_SEND_VARS)[number]) => (env[k] ?? "").trim();
  const missing = SES_SEND_VARS.filter((k) => !v(k));
  if (missing.length) return { ok: false, missing };
  return { ok: true, config: { accessKeyId: v("SES_ACCESS_KEY_ID"), secretAccessKey: v("SES_SECRET_ACCESS_KEY"), region: v("SES_REGION"), configurationSet: v("SES_CONFIGURATION_SET") } };
}

/** Business slug sent as the SES tag business=<slug>. */
export const SES_BUSINESS_SLUG = "crestmont";
/** SES tag values allow [A-Za-z0-9_-] only (and at most 256 characters). */
export const sesTagValue = (v: string) => (v.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256) || "none");

// ───────────── SigV4 ─────────────

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}
/** RFC 3986 encoding as SigV4 requires (encodeURIComponent leaves !'()* unescaped). */
const uriEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SigV4Input {
  method: string; url: string; headers: Record<string, string>; body: string;
  accessKeyId: string; secretAccessKey: string; region: string; service: string; now?: Date;
}

/** Returns the request headers with x-amz-date, x-amz-content-sha256 and Authorization added (host is signed too). */
export async function signSigV4(i: SigV4Input): Promise<Record<string, string>> {
  const u = new URL(i.url);
  const amzDate = (i.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = await sha256(i.body);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.headers)) headers[k.toLowerCase()] = v;
  headers.host = u.host;
  headers["x-amz-date"] = amzDate;
  headers["x-amz-content-sha256"] = payloadHash;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const path = u.pathname.split("/").map((seg) => uriEncode(decodeURIComponent(seg))).join("/") || "/";
  const query = [...u.searchParams].map(([k, v]) => [uriEncode(k), uriEncode(v)]).sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonicalRequest = [i.method.toUpperCase(), path, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${i.region}/${i.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonicalRequest)].join("\n");
  let key = await hmac(enc.encode(`AWS4${i.secretAccessKey}`), date);
  key = await hmac(key, i.region);
  key = await hmac(key, i.service);
  key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, stringToSign));
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

// ───────────── Sending ─────────────

/** A send that must not be retried (the request itself is wrong, or the account/identity refuses it). */
export class PermanentSendError extends Error {}

export interface SesSendInput { from: string; to: string[]; replyTo: string[]; subject: string; html: string; text: string; tags: Record<string, string> }

export function sesRequestBody(cfg: SesConfig, m: SesSendInput): Record<string, unknown> {
  return {
    FromEmailAddress: m.from,
    Destination: { ToAddresses: m.to },
    ReplyToAddresses: m.replyTo,
    Content: { Simple: { Subject: { Data: m.subject, Charset: "UTF-8" }, Body: { Html: { Data: m.html, Charset: "UTF-8" }, Text: { Data: m.text, Charset: "UTF-8" } } } },
    ConfigurationSetName: cfg.configurationSet,
    EmailTags: Object.entries(m.tags).map(([Name, Value]) => ({ Name, Value: sesTagValue(Value) })),
  };
}

const RETRYABLE_TYPES = /^(TooManyRequestsException|LimitExceededException|ThrottlingException|InternalFailure|ServiceUnavailable)/;

/**
 * Error mapping: 429, 5xx and throttling types are retryable (plain Error, so the caller's normal retry/backoff
 * applies); every other 4xx (MessageRejected, MailFromDomainNotVerified, AccountSuspended, "Email address is not
 * verified" in the sandbox, bad request, bad credentials) is a PermanentSendError.
 */
export function sesError(status: number, errorType: string, message: string): Error {
  const text = `SES ${status}${errorType ? ` ${errorType}` : ""}: ${message || "error"}`;
  if (status === 429 || status >= 500 || RETRYABLE_TYPES.test(errorType)) return new Error(text);
  return new PermanentSendError(text);
}

/** Sends one message; returns the SES MessageId. Network failures propagate as plain (retryable) errors. */
export async function sesSend(cfg: SesConfig, m: SesSendInput, fetchImpl: typeof fetch = fetch, now?: Date): Promise<string | null> {
  const url = `https://email.${cfg.region}.amazonaws.com/v2/email/outbound-emails`;
  const body = JSON.stringify(sesRequestBody(cfg, m));
  const headers = await signSigV4({ method: "POST", url, headers: { "content-type": "application/json" }, body, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: cfg.region, service: "ses", now });
  delete headers.host; // set by fetch from the URL (it was signed with the same value)
  const r = await fetchImpl(url, { method: "POST", headers, body });
  const data = (await r.json().catch(() => ({}))) as { MessageId?: string; message?: string; Message?: string; __type?: string };
  if (!r.ok) {
    const type = (r.headers.get("x-amzn-errortype") ?? data.__type ?? "").split(":")[0].split("#").pop() ?? "";
    throw sesError(r.status, type, String(data.message ?? data.Message ?? "").slice(0, 300));
  }
  return typeof data.MessageId === "string" ? data.MessageId : null;
}

// ───────────── SNS signature verification ─────────────

export class SnsAuthError extends Error {}
export const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;

export interface SnsMessage {
  Type: string; MessageId: string; TopicArn: string; Message: string; Timestamp: string; Signature: string;
  SignatureVersion: string; SigningCertURL: string; Subject?: string; SubscribeURL?: string; Token?: string;
}

/** https, host sns.<region>.amazonaws.com, path ending .pem. */
export function snsCertUrlOk(raw: string): boolean {
  try { const u = new URL(raw); return u.protocol === "https:" && SNS_HOST.test(u.hostname) && !u.port && u.pathname.endsWith(".pem"); } catch { return false; }
}
export function snsUrlOk(raw: string | undefined): boolean {
  if (!raw) return false;
  try { const u = new URL(raw); return u.protocol === "https:" && SNS_HOST.test(u.hostname) && !u.port; } catch { return false; }
}

const NOTIFICATION_KEYS = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] as const;
const SUBSCRIPTION_KEYS = ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"] as const;

/** The string SNS signs: "Key\nValue\n" for each present key, in AWS's fixed order for the message type. */
export function snsCanonicalString(m: Record<string, unknown>): string {
  const keys = m.Type === "Notification" ? NOTIFICATION_KEYS : SUBSCRIPTION_KEYS;
  let out = "";
  for (const k of keys) {
    const v = m[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") throw new SnsAuthError(`${k} must be a string`);
    out += `${k}\n${v}\n`;
  }
  return out;
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Minimal DER walk: the SubjectPublicKeyInfo of an X.509 certificate (tbsCertificate field 7, or 6 without version). */
export function spkiFromCertificate(der: Uint8Array): Uint8Array {
  const read = (pos: number): { tag: number; start: number; end: number; next: number } => {
    if (pos + 2 > der.length) throw new SnsAuthError("Truncated certificate");
    const tag = der[pos];
    let len = der[pos + 1], start = pos + 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n < 1 || n > 4) throw new SnsAuthError("Unsupported certificate length");
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + der[start + i];
      start += n;
    }
    if (start + len > der.length) throw new SnsAuthError("Truncated certificate");
    return { tag, start, end: start + len, next: start + len };
  };
  const cert = read(0);
  if (cert.tag !== 0x30) throw new SnsAuthError("Not a certificate");
  const tbs = read(cert.start);
  if (tbs.tag !== 0x30) throw new SnsAuthError("Not a certificate");
  let p = tbs.start;
  let el = read(p);
  if (el.tag === 0xa0) { p = el.next; el = read(p); } // [0] version
  // serialNumber, signature, issuer, validity, subject, then subjectPublicKeyInfo
  for (let i = 0; i < 5; i++) { p = el.next; el = read(p); }
  if (el.tag !== 0x30) throw new SnsAuthError("Certificate has no public key");
  return der.slice(p, el.end);
}

export function pemToDer(pem: string): Uint8Array {
  const m = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(pem);
  if (!m) throw new SnsAuthError("Signing certificate is not a PEM certificate");
  return b64decode(m[1]);
}

export type CertFetcher = (url: string) => Promise<string>;
const certCache = new Map<string, Promise<Uint8Array>>();
const CERT_CACHE_MAX = 20;
/** Test seam: clears the in-memory certificate cache. */
export function clearSnsCertCache() { certCache.clear(); }

async function publicKeySpki(url: string, fetchCert: CertFetcher): Promise<Uint8Array> {
  let p = certCache.get(url);
  if (!p) {
    p = fetchCert(url).then((pem) => spkiFromCertificate(pemToDer(pem)));
    if (certCache.size >= CERT_CACHE_MAX) certCache.delete(certCache.keys().next().value as string);
    certCache.set(url, p);
    p.catch(() => certCache.delete(url)); // a failed fetch is not cached
  }
  return p;
}

export function defaultCertFetcher(fetchImpl: typeof fetch = fetch): CertFetcher {
  return async (url) => {
    const r = await fetchImpl(url, { redirect: "manual" }); // a redirect (3xx) is not followed and fails below
    if (!r.ok) throw new SnsAuthError(`Signing certificate fetch failed (HTTP ${r.status})`);
    return r.text();
  };
}

/** Parses and verifies one SNS HTTP(S) delivery. Throws SnsAuthError on anything that does not verify. */
export async function verifySnsMessage(raw: string, fetchCert: CertFetcher): Promise<SnsMessage> {
  let m: Record<string, unknown>;
  try { m = JSON.parse(raw) as Record<string, unknown>; } catch { throw new SnsAuthError("Body is not JSON"); }
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new SnsAuthError("Body is not an SNS message");
  for (const k of ["Type", "MessageId", "TopicArn", "Timestamp", "Signature", "SignatureVersion", "SigningCertURL"]) if (typeof m[k] !== "string" || !m[k]) throw new SnsAuthError(`Missing ${k}`);
  if (typeof m.Message !== "string") throw new SnsAuthError("Missing Message");
  const type = m.Type as string;
  if (!["Notification", "SubscriptionConfirmation", "UnsubscribeConfirmation"].includes(type)) throw new SnsAuthError("Unknown message type");
  if (type !== "Notification" && (typeof m.SubscribeURL !== "string" || typeof m.Token !== "string")) throw new SnsAuthError("Missing SubscribeURL or Token");
  const hash = m.SignatureVersion === "1" ? "SHA-1" : m.SignatureVersion === "2" ? "SHA-256" : null;
  if (!hash) throw new SnsAuthError("Unsupported SignatureVersion");
  if (!snsCertUrlOk(m.SigningCertURL as string)) throw new SnsAuthError("SigningCertURL is not an SNS certificate URL");
  let spki: Uint8Array;
  try { spki = await publicKeySpki(m.SigningCertURL as string, fetchCert); } catch (e) { throw e instanceof SnsAuthError ? e : new SnsAuthError("Signing certificate unavailable"); }
  let ok = false;
  try {
    const key = await crypto.subtle.importKey("spki", spki as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
    ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64decode(m.Signature as string) as BufferSource, enc.encode(snsCanonicalString(m)));
  } catch { ok = false; }
  if (!ok) throw new SnsAuthError("Signature mismatch");
  return m as unknown as SnsMessage;
}
