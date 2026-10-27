// Minimal PDF 1.4 writer (PAY-005). Zero dependencies: text in the standard Helvetica and
// Helvetica-Bold fonts (WinAnsiEncoding, no embedding needed), lines, filled rectangles and a
// simple paginated table. The output is pure 7-bit ASCII (non-ASCII text bytes are written as
// octal escapes), so every byte offset in the cross-reference table equals the string index.
//
// Coordinates are PDF points (1/72 in) from the bottom-left corner; the A4/Letter choice is the
// caller's (default US Letter, 612 × 792).

export type Rgb = readonly [number, number, number];
export interface TextOpts { size?: number; bold?: boolean; color?: Rgb; align?: "left" | "right" | "center" }

// Glyph widths (1/1000 em) for WinAnsi 32–126 from the Adobe Core 14 AFM files.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722,
  667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556,
  333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELV_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722,
  667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611,
  389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

// Unicode → WinAnsi (cp1252) for the characters that differ from Latin-1 and that our copy uses.
const WIN_ANSI: Record<number, number> = { 0x20ac: 0x80, 0x2026: 0x85, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2122: 0x99, 0x2212: 0x2d, 0x2192: 0x3e, 0x00a0: 0x20 };
const HIGH_WIDTH: Record<number, [number, number]> = { 0x80: [556, 556], 0x85: [1000, 1000], 0x91: [222, 278], 0x92: [222, 278], 0x93: [333, 500], 0x94: [333, 500], 0x95: [350, 350], 0x96: [556, 556], 0x97: [1000, 1000], 0x99: [1000, 1000] };

/** Text → WinAnsi byte values. Characters outside WinAnsi become "?"; control characters become spaces. */
export function winAnsiBytes(s: string): number[] {
  const out: number[] = [];
  for (const ch of s.normalize("NFC")) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) out.push(0x20);
    else if (cp < 0x20 || cp === 0x7f) continue;
    else if (cp in WIN_ANSI) out.push(WIN_ANSI[cp]);
    else if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) out.push(cp);
    else out.push(0x3f);
  }
  return out;
}

/** A PDF literal string: ( ) \ escaped, bytes ≥ 0x80 as 3-digit octal, so the file stays ASCII. */
export function pdfString(s: string): string {
  let o = "(";
  for (const b of winAnsiBytes(s)) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) o += "\\" + String.fromCharCode(b);
    else if (b >= 0x80) o += "\\" + b.toString(8).padStart(3, "0");
    else o += String.fromCharCode(b);
  }
  return o + ")";
}

export function textWidth(s: string, size: number, bold = false): number {
  const table = bold ? HELV_BOLD : HELV;
  let w = 0;
  for (const b of winAnsiBytes(s)) w += b >= 32 && b <= 126 ? table[b - 32] : (HIGH_WIDTH[b]?.[bold ? 1 : 0] ?? 556);
  return (w * size) / 1000;
}

/** Greedy word wrap to a maximum width; a single over-long word is hard-broken. */
export function wrapText(s: string, maxWidth: number, size: number, bold = false): string[] {
  const lines: string[] = [];
  for (const para of s.split(/\r?\n/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, size, bold) <= maxWidth) { line = candidate; continue; }
      if (line) lines.push(line);
      let w = word;
      while (textWidth(w, size, bold) > maxWidth && w.length > 1) {
        let n = w.length - 1;
        while (n > 1 && textWidth(w.slice(0, n), size, bold) > maxWidth) n--;
        lines.push(w.slice(0, n)); w = w.slice(n);
      }
      line = w;
    }
    lines.push(line);
  }
  return lines;
}

const num = (n: number) => (Math.round(n * 100) / 100).toString();
const rgb = (c: Rgb) => c.map((v) => num(v)).join(" ");

export class PdfPage {
  readonly ops: string[] = [];
  readonly width: number; readonly height: number;
  constructor(width: number, height: number) { this.width = width; this.height = height; }

  text(x: number, y: number, s: string, o: TextOpts = {}): this {
    const size = o.size ?? 10;
    const w = o.align && o.align !== "left" ? textWidth(s, size, o.bold) : 0;
    const tx = o.align === "right" ? x - w : o.align === "center" ? x - w / 2 : x;
    this.ops.push(`BT /${o.bold ? "F2" : "F1"} ${num(size)} Tf ${rgb(o.color ?? [0, 0, 0])} rg ${num(tx)} ${num(y)} Td ${pdfString(s)} Tj ET`);
    return this;
  }

  line(x1: number, y1: number, x2: number, y2: number, o: { width?: number; color?: Rgb } = {}): this {
    this.ops.push(`${num(o.width ?? 0.5)} w ${rgb(o.color ?? [0, 0, 0])} RG ${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`);
    return this;
  }

  rect(x: number, y: number, w: number, h: number, fill: Rgb): this {
    this.ops.push(`${rgb(fill)} rg ${num(x)} ${num(y)} ${num(w)} ${num(h)} re f`);
    return this;
  }

  content(): string { return this.ops.join("\n") + "\n"; }
}

export interface DocInfo { title: string; author?: string; subject?: string; creationDate?: Date }

export class PdfDocument {
  readonly pages: PdfPage[] = [];
  readonly width: number; readonly height: number;
  private info: DocInfo;
  constructor(info: DocInfo, size: { width: number; height: number } = { width: 612, height: 792 }) {
    this.info = info; this.width = size.width; this.height = size.height;
  }

  addPage(): PdfPage {
    const p = new PdfPage(this.width, this.height);
    this.pages.push(p);
    return p;
  }

  /** Serializes the document. Object numbers: 1 catalog, 2 page tree, 3–4 fonts, 5 info, then page/content pairs. */
  toBytes(): Uint8Array<ArrayBuffer> {
    if (!this.pages.length) this.addPage();
    const objs: string[] = [];
    const pageIds = this.pages.map((_, i) => 6 + i * 2);
    objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
    objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
    objs[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
    objs[4] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`;
    const d = this.info.creationDate ?? new Date(0);
    const pdfDate = `D:${d.toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`;
    objs[5] = `<< /Title ${pdfString(this.info.title)} /Producer ${pdfString("Crestmont platform PDF writer")}${this.info.author ? ` /Author ${pdfString(this.info.author)}` : ""}${this.info.subject ? ` /Subject ${pdfString(this.info.subject)}` : ""} /CreationDate ${pdfString(pdfDate)} >>`;
    this.pages.forEach((p, i) => {
      const content = p.content();
      objs[pageIds[i]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`;
      objs[pageIds[i] + 1] = `<< /Length ${content.length} >>\nstream\n${content}endstream`;
    });
    let out = "%PDF-1.4\n%âãÏÓ\n";
    const offsets: number[] = [];
    for (let n = 1; n < objs.length; n++) {
      offsets[n] = out.length;
      out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
    }
    const xref = out.length;
    out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
    for (let n = 1; n < objs.length; n++) out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
  }
}

// ── Flowing layout helper: a cursor that starts new pages when space runs out ──

export interface TableColumn { header: string; width: number; align?: "left" | "right" }

export class PdfFlow {
  readonly doc: PdfDocument;
  page!: PdfPage;
  y = 0;
  readonly margin: number;
  private onNewPage: (page: PdfPage, flow: PdfFlow) => void;
  constructor(doc: PdfDocument, opts: { margin?: number; onNewPage?: (page: PdfPage, flow: PdfFlow) => void } = {}) {
    this.doc = doc; this.margin = opts.margin ?? 54; this.onNewPage = opts.onNewPage ?? (() => {});
    this.newPage();
  }
  get contentWidth() { return this.doc.width - this.margin * 2; }
  newPage() {
    this.page = this.doc.addPage();
    this.y = this.doc.height - this.margin;
    this.onNewPage(this.page, this);
  }
  ensure(h: number) { if (this.y - h < this.margin + 24) this.newPage(); }
  gap(h: number) { this.y -= h; }

  paragraph(s: string, o: TextOpts & { width?: number; leading?: number } = {}) {
    const size = o.size ?? 10, leading = o.leading ?? size * 1.35;
    for (const l of wrapText(s, o.width ?? this.contentWidth, size, o.bold)) {
      this.ensure(leading);
      this.y -= leading;
      this.page.text(this.margin, this.y + (leading - size) / 2, l, o);
    }
  }

  /** Label/value rows in two columns. */
  pairs(rows: [string, string][], o: { labelWidth?: number; size?: number } = {}) {
    const size = o.size ?? 9.5, lw = o.labelWidth ?? 150, leading = size * 1.45;
    for (const [k, v] of rows) {
      const lines = wrapText(v, this.contentWidth - lw, size);
      this.ensure(leading * lines.length);
      lines.forEach((l, i) => {
        this.y -= leading;
        if (i === 0) this.page.text(this.margin, this.y, k, { size, bold: true, color: [0.25, 0.25, 0.25] });
        this.page.text(this.margin + lw, this.y, l, { size });
      });
    }
  }

  /** A table with a header row (repeated on each new page), wrapped cells and right-aligned numeric columns. */
  table(cols: TableColumn[], rows: string[][], o: { size?: number; headerFill?: Rgb; rule?: Rgb } = {}) {
    const size = o.size ?? 9, leading = size * 1.4, pad = 4;
    const header = () => {
      this.ensure(leading + pad * 2);
      this.page.rect(this.margin, this.y - leading - pad, this.contentWidth, leading + pad, o.headerFill ?? [0.07, 0.07, 0.07]);
      let x = this.margin;
      this.y -= leading;
      for (const c of cols) {
        this.page.text(c.align === "right" ? x + c.width - pad : x + pad, this.y - 1, c.header, { size, bold: true, color: [1, 1, 1], align: c.align === "right" ? "right" : "left" });
        x += c.width;
      }
      this.y -= pad;
    };
    header();
    for (const r of rows) {
      const cells = cols.map((c, i) => wrapText(r[i] ?? "", c.width - pad * 2, size));
      const h = Math.max(...cells.map((c) => c.length)) * leading + pad;
      if (this.y - h < this.margin + 24) { this.newPage(); header(); }
      let x = this.margin;
      cells.forEach((lines, i) => {
        const c = cols[i];
        lines.forEach((l, j) => this.page.text(c.align === "right" ? x + c.width - pad : x + pad, this.y - leading * (j + 1), l, { size, align: c.align === "right" ? "right" : "left" }));
        x += c.width;
      });
      this.y -= h;
      this.page.line(this.margin, this.y, this.margin + this.contentWidth, this.y, { width: 0.4, color: o.rule ?? [0.8, 0.8, 0.8] });
    }
  }
}
