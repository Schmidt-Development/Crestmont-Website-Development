// Auto-escaping HTML templating (SEC-001 output encoding, SEC-002 XSS).
// Every interpolated value is escaped unless it is already SafeHtml produced by `html` or `raw`.

export class SafeHtml {
  readonly value: string;
  constructor(value: string) { this.value = value; }
  toString(): string { return this.value; }
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"'`]/g, (c) => ESC[c]);
}

type Interp = SafeHtml | string | number | boolean | null | undefined | Interp[];

function render(v: Interp): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  return escapeHtml(String(v));
}

export function html(strings: TemplateStringsArray, ...values: Interp[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Only for trusted, static markup authored in this repository. Never pass user input. */
export function raw(s: string): SafeHtml { return new SafeHtml(s); }

export function join(items: SafeHtml[], sep = ""): SafeHtml { return new SafeHtml(items.map((i) => i.value).join(sep)); }

/** Only http(s), mailto, tel and same-site paths are allowed in href/src. */
export function safeUrl(u: string | null | undefined): string {
  if (!u) return "#";
  const s = u.trim();
  if (/^(https?:|mailto:|tel:)/i.test(s) || (s.startsWith("/") && !s.startsWith("//"))) return s;
  return "#";
}

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "Unknown";
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: cents % 100 ? 2 : 0 });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "America/New_York" });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" });
}

export function label(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
