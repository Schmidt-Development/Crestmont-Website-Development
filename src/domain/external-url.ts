// Validating the address of an externally hosted website before it is stored on a customer's project.
//
// The address is only ever OPENED BY THE CUSTOMER'S BROWSER, in a new tab. Crestmont never fetches, frames or
// proxies it, so there is no server-side request to forge. These rules exist so that what staff paste is a real,
// public HTTPS website and nothing that could be dangerous or meaningless when a customer clicks it:
//
//   - https only (no http:, javascript:, data:, file:, ftp: or anything else);
//   - no embedded credentials (https://user:pass@host);
//   - no IP-address hosts at all, which covers every private, loopback, link-local and metadata address in every
//     notation the URL parser accepts (decimal, hex, octal, IPv6, IPv4-mapped IPv6);
//   - no localhost and no private, reserved or internal-only names (.local, .internal, .test, .lan, ...);
//   - a syntactically valid public hostname with a real top-level domain;
//   - the default HTTPS port only.
//
// Saving an address that passes these rules says nothing about the website's own security or content. It is not
// an audit, and nothing in Website Delivery claims otherwise.

export const EXTERNAL_URL_MAX = 2048;

/** Names that never point at a public website: special-use and internal-only suffixes. */
const PRIVATE_SUFFIXES = [
  "localhost", "local", "localdomain", "internal", "intranet", "lan", "home", "corp", "private",
  "test", "example", "invalid", "onion", "arpa", "home.arpa",
];

export type ExternalUrlResult = { ok: true; url: string; host: string } | { ok: false; error: string };

export function validateExternalUrl(input: unknown): ExternalUrlResult {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return { ok: false, error: "Enter the website's full address, starting with https://." };
  if (raw.length > EXTERNAL_URL_MAX) return { ok: false, error: `The address is too long (at most ${EXTERNAL_URL_MAX} characters).` };
  // Whitespace or control characters inside an address are either a paste mistake or an attempt to confuse a parser.
  if (/[\s\u0000-\u001f\u007f\\]/.test(raw)) return { ok: false, error: "The address contains spaces or characters that are not allowed in a web address." };
  if (!/^https:\/\//i.test(raw)) {
    return { ok: false, error: /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https:/i.test(raw)
      ? "Only secure https:// addresses can be shared with a customer."
      : "Enter the full address, starting with https:// (for example https://customer-website.pages.dev)." };
  }

  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, error: "That is not a valid web address." }; }
  if (u.protocol !== "https:") return { ok: false, error: "Only secure https:// addresses can be shared with a customer." };
  if (u.username || u.password) return { ok: false, error: "The address must not contain a username or password." };
  if (u.port && u.port !== "443") return { ok: false, error: "The address must use the standard https port." };

  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, error: "The address has no website name." };
  // IPv6 literals arrive bracketed; IPv4 in any notation is normalised to dotted decimal by the parser.
  if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return { ok: false, error: "Use the website's domain name, not an IP address." };
  }
  const labels = host.split(".");
  if (labels.length < 2) return { ok: false, error: "The address must be a public website domain (for example customer-domain.com)." };
  if (host.length > 253 || labels.some((l) => !/^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(l))) {
    return { ok: false, error: "The website's domain name is not valid." };
  }
  const tld = labels[labels.length - 1];
  if (!/^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return { ok: false, error: "The website's domain name is not valid." };
  for (const s of PRIVATE_SUFFIXES) {
    if (host === s || host.endsWith(`.${s}`)) return { ok: false, error: "That address points at a private or internal network, not a public website." };
  }
  return { ok: true, url: u.href, host };
}
