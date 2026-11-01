// HTTP helpers: JSON responses with security headers, structured errors, safe body parsing.

export class HttpError extends Error {
  /** @param {number} status @param {string} code @param {string} message @param {Record<string, unknown>} [extra] */
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}

export const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://checkout.stripe.com",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

/** @param {unknown} body @param {number} [status] @param {Record<string, string>} [headers] */
export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...headers } });
}

/** Structured error body: { error: { code, message, ...extra } }. Internal details never leak to the client. */
export function errorResponse(err) {
  if (err instanceof HttpError) return json({ error: { code: err.code, message: err.message, ...err.extra } }, err.status);
  return json({ error: { code: "internal_error", message: "Something went wrong on our side. Please try again." } }, 500);
}

/** Parse a JSON body with a size limit; anything else is a 400/413/415. */
export async function readJson(request, maxBytes = 32_768) {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, "unsupported_media_type", "Send JSON (content-type: application/json).");
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "payload_too_large", "The request is too large.");
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v;
  } catch { throw new HttpError(400, "invalid_json", "The request body is not valid JSON."); }
}

export function clientIp(request) {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
}

export function cookie(request, name) {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}
