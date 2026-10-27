// Safe rich text for CMS long-text fields (BRAND-004). A deliberately small markdown subset:
//   ## Heading / ### Subheading   (a single "#" is treated as "##" so pages keep one h1)
//   **bold**  *italic*  _italic_  [text](https://… | http://… | mailto:…)
//   - bullet / * bullet           1. numbered
//   blank line = new paragraph
// There is NO raw HTML passthrough: every character of input is escaped, and only the markup this
// renderer writes itself reaches the page. Links with any other scheme (javascript:, data:, relative,
// protocol-relative …) are rendered as their plain text. Plain text without markup renders exactly as
// the previous "paragraphs separated by a blank line" format did.
import { escapeHtml, raw, type SafeHtml } from "../lib/html.ts";

export const MARKDOWN_MAX = 20_000;

const SAFE_LINK = /^(https?:\/\/[^\s"'<>`]+|mailto:[^\s"'<>`/]+@[^\s"'<>`]+)$/i;

/** True when the URL is allowed in a rendered link. */
export function isSafeLink(url: string): boolean {
  return SAFE_LINK.test(url.trim()) && url.length <= 500;
}

// Earliest-match inline tokenizer. Order inside the alternation matters only for ties.
const INLINE = /\[([^\]\n]{1,300})\]\(([^)\s]{1,500})\)|\*\*(?=\S)([\s\S]*?\S)\*\*|\*(?=[^\s*])([^*\n]*?[^\s*])\*|(?<![A-Za-z0-9])_(?=[^\s_])([^_\n]*?[^\s_])_(?![A-Za-z0-9])/;

function inline(text: string, allowLinks = true, depth = 0): string {
  if (depth > 6) return escapeHtml(text);
  let out = "";
  let rest = text;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) { out += escapeHtml(rest); break; }
    out += escapeHtml(rest.slice(0, m.index));
    const [whole, linkText, linkUrl, bold, star, under] = m;
    if (linkText !== undefined) {
      if (allowLinks && isSafeLink(linkUrl)) {
        const external = /^https?:/i.test(linkUrl);
        out += `<a href="${escapeHtml(linkUrl.trim())}"${external ? ` rel="noopener noreferrer"` : ""}>${inline(linkText, false, depth + 1)}</a>`;
      } else {
        // Unsafe or nested link: keep the words, drop the target.
        out += inline(linkText, false, depth + 1);
      }
    } else if (bold !== undefined) out += `<strong>${inline(bold, allowLinks, depth + 1)}</strong>`;
    else if (star !== undefined) out += `<em>${inline(star, allowLinks, depth + 1)}</em>`;
    else if (under !== undefined) out += `<em>${inline(under, allowLinks, depth + 1)}</em>`;
    else out += escapeHtml(whole);
    rest = rest.slice(m.index + whole.length);
  }
  return out;
}

const BULLET = /^\s{0,3}[-*]\s+(.*)$/;
const NUMBER = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/;

/** Renders the markdown subset to escaped HTML. */
export function renderMarkdown(src: string | null | undefined): SafeHtml {
  const text = (src ?? "").replace(/\r\n?/g, "\n").slice(0, MARKDOWN_MAX);
  const out: string[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) continue;
    let para: string[] = [];
    let list: { kind: "ul" | "ol"; items: string[] } | null = null;
    const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(" ").replace(/\s+/g, " ").trim())}</p>`); para = []; };
    const flushList = () => { if (list) out.push(`<${list.kind}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.kind}>`); list = null; };
    for (const line of lines) {
      const h = HEADING.exec(line);
      const b = BULLET.exec(line);
      const n = NUMBER.exec(line);
      if (h) {
        flushPara(); flushList();
        const level = h[1].length === 3 ? 3 : 2;
        out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      } else if (b || n) {
        flushPara();
        const kind = b ? "ul" : "ol";
        if (list && list.kind !== kind) flushList();
        if (!list) list = { kind, items: [] };
        list.items.push((b ?? n)![1].trim());
      } else if (list && /^\s{2,}\S/.test(line)) {
        // Indented continuation of the previous list item.
        list.items[list.items.length - 1] += " " + line.trim();
      } else {
        flushList();
        para.push(line.trim());
      }
    }
    flushPara(); flushList();
  }
  return raw(out.join("\n"));
}

/** Problems an editor should fix before saving (unsafe links are otherwise silently reduced to text). */
export function markdownIssues(src: string): string[] {
  const issues: string[] = [];
  const re = /\[([^\]\n]{1,300})\]\(([^)\s]{1,500})\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (!isSafeLink(m[2])) issues.push(`Link "${m[1]}" must start with https://, http:// or mailto:`);
  }
  if (/<\s*[a-z!/]/i.test(src)) issues.push("HTML tags are not allowed; use the formatting toolbar (markdown) instead");
  return issues;
}
