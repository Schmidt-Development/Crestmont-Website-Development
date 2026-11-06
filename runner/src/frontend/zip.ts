// Reading a ZIP archive the Founder uploaded, without trusting any of it.
//
// WHY THIS IS HAND-WRITTEN. The runner has no dependencies at all, by design, and this code's whole input is a
// file someone uploaded. Adding a third-party parser here would add supply-chain surface at exactly the point
// where hostile input first meets the system. `node:zlib` already does the one hard part (inflate) with a hard
// output cap, so the rest is header parsing — bounded, auditable, and ours.
//
// WHAT IT GUARANTEES. Nothing is written to disk by this module, and nothing is inflated until a caller asks for
// a specific entry. The listing comes from the CENTRAL DIRECTORY, which is what `artifact.ts` judges, so a
// verdict is reached before any byte is decompressed. Then:
//
//   - every offset and length is checked against the buffer before it is used;
//   - the local header's sizes are ignored in favour of the central directory's (the classic mismatch trick);
//   - inflate runs with `maxOutputLength`, so a file that claims 2 KB and expands to 2 GB fails instead of
//     taking the process with it;
//   - CRC-32 and the uncompressed length are both verified after inflating;
//   - encrypted entries and compression methods other than store/deflate are refused rather than guessed at.

import { crc32, inflateRawSync } from "node:zlib";
import { shouldReadAsText } from "./artifact.ts";
import type { ArchiveEntry } from "./artifact.ts";

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** Unix file-type bits from the external attributes' high 16 bits. */
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;
const S_IFDIR = 0x4000;

export const ZIP_LIMITS = {
  /** Enough for any website; stops a crafted central directory from being a parsing DoS. */
  maxEntries: 20_000,
  /** No single file in a frontend is larger than this, and inflate is capped at it. */
  maxFileBytes: 50 * 1024 * 1024,
  /** Total declared uncompressed size across the archive. */
  maxTotalBytes: 250 * 1024 * 1024,
  /** A path longer than this is not a real path. */
  maxPathLength: 1024,
} as const;

export interface ZipEntry {
  /** The name exactly as the archive records it. NOT normalised — `artifact.ts` judges the raw string. */
  path: string;
  /** Uncompressed size, from the central directory. */
  size: number;
  compressedSize: number;
  /** 0 = stored, 8 = deflate. Anything else is refused at read time. */
  method: number;
  crc: number;
  localOffset: number;
  /** The Unix mode from the external attributes, 0 when the archive did not record one. */
  unixMode: number;
  type: "file" | "dir" | "symlink";
  /** Set when the entry is encrypted, which this reader refuses. */
  encrypted: boolean;
}

export class ZipError extends Error {}

const u16 = (b: Buffer, o: number): number => b.readUInt16LE(o);
const u32 = (b: Buffer, o: number): number => b.readUInt32LE(o);
/** 64-bit little-endian as a Number. Beyond 2^53 is not a real website, so it is refused rather than truncated. */
function u64(b: Buffer, o: number): number {
  const v = b.readBigUInt64LE(o);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError("the archive declares a size this reader will not handle");
  return Number(v);
}

/**
 * A parsed archive. `open()` reads only the central directory; entry data is inflated on demand.
 */
export class ZipArchive {
  readonly entries: readonly ZipEntry[];
  readonly compressedBytes: number;
  private readonly buf: Buffer;

  private constructor(buf: Buffer, entries: ZipEntry[]) {
    this.buf = buf;
    this.entries = entries;
    this.compressedBytes = buf.length;
  }

  static open(buf: Buffer): ZipArchive {
    if (buf.length < 22) throw new ZipError("the file is too small to be a ZIP archive");

    // End of central directory: scan backwards, bounded by the maximum comment length.
    const scanFrom = Math.max(0, buf.length - 22 - 0xffff);
    let eocd = -1;
    for (let i = buf.length - 22; i >= scanFrom; i--) {
      if (u32(buf, i) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new ZipError("this is not a ZIP archive (no end-of-central-directory record was found)");

    let total = u16(buf, eocd + 10);
    let cdSize = u32(buf, eocd + 12);
    let cdOffset = u32(buf, eocd + 16);

    // ZIP64, when any of the 32-bit fields is saturated. The locator sits immediately before the EOCD.
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc < 0 || u32(buf, loc) !== SIG_EOCD64_LOCATOR) throw new ZipError("the archive needs ZIP64 but has no ZIP64 locator");
      const z64 = u64(buf, loc + 8);
      if (z64 < 0 || z64 + 56 > buf.length || u32(buf, z64) !== SIG_EOCD64) throw new ZipError("the archive's ZIP64 end-of-central-directory record is not where it says it is");
      total = u64(buf, z64 + 32);
      cdSize = u64(buf, z64 + 40);
      cdOffset = u64(buf, z64 + 48);
    }

    if (total > ZIP_LIMITS.maxEntries) throw new ZipError(`the archive declares ${total} entries, above the ${ZIP_LIMITS.maxEntries} limit`);
    if (cdOffset < 0 || cdSize < 0 || cdOffset + cdSize > buf.length) throw new ZipError("the archive's central directory is outside the file");

    const entries: ZipEntry[] = [];
    let p = cdOffset;
    const cdEnd = cdOffset + cdSize;
    let declaredTotal = 0;

    for (let i = 0; i < total; i++) {
      if (p + 46 > cdEnd) throw new ZipError(`the central directory ends part-way through entry ${i + 1}`);
      if (u32(buf, p) !== SIG_CENTRAL) throw new ZipError(`entry ${i + 1} of the central directory has a bad signature`);

      const flags = u16(buf, p + 8);
      const method = u16(buf, p + 10);
      const crc = u32(buf, p + 16);
      let compressedSize = u32(buf, p + 20);
      let size = u32(buf, p + 24);
      const nameLen = u16(buf, p + 28);
      const extraLen = u16(buf, p + 30);
      const commentLen = u16(buf, p + 32);
      const externalAttrs = u32(buf, p + 38);
      let localOffset = u32(buf, p + 42);

      if (p + 46 + nameLen + extraLen + commentLen > cdEnd) throw new ZipError(`entry ${i + 1} declares more data than the central directory holds`);
      if (nameLen > ZIP_LIMITS.maxPathLength) throw new ZipError(`entry ${i + 1} has a path of ${nameLen} bytes, which is not a real path`);

      // The name is decoded as UTF-8. Every character the path rules care about — "..", "/", "\", ":", NUL — is
      // ASCII, and so identical under CP437, so a non-UTF-8 name cannot smuggle a traversal past `unsafePath`.
      const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");

      // ZIP64 extra field: authoritative for whichever 32-bit fields were saturated.
      if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
        const extraStart = p + 46 + nameLen;
        let q = extraStart;
        let found = false;
        while (q + 4 <= extraStart + extraLen) {
          const id = u16(buf, q);
          const len = u16(buf, q + 2);
          if (q + 4 + len > extraStart + extraLen) break;
          if (id === 0x0001) {
            let r = q + 4;
            if (size === 0xffffffff) { size = u64(buf, r); r += 8; }
            if (compressedSize === 0xffffffff) { compressedSize = u64(buf, r); r += 8; }
            if (localOffset === 0xffffffff) { localOffset = u64(buf, r); r += 8; }
            found = true;
            break;
          }
          q += 4 + len;
        }
        if (!found) throw new ZipError(`entry ${i + 1} ("${name.slice(0, 80)}") needs a ZIP64 extra field and has none`);
      }

      if (size < 0 || compressedSize < 0) throw new ZipError(`entry ${i + 1} declares a negative size`);
      if (localOffset + 30 > buf.length) throw new ZipError(`entry ${i + 1} points outside the file`);
      declaredTotal += size;
      if (declaredTotal > ZIP_LIMITS.maxTotalBytes) {
        throw new ZipError(`the archive's entries declare more than ${Math.round(ZIP_LIMITS.maxTotalBytes / 1024 / 1024)} MB uncompressed`);
      }

      const unixMode = (externalAttrs >>> 16) & 0xffff;
      const isLink = (unixMode & S_IFMT) === S_IFLNK;
      const isDir = name.endsWith("/") || (unixMode & S_IFMT) === S_IFDIR;

      entries.push({
        path: name,
        size,
        compressedSize,
        method,
        crc,
        localOffset,
        unixMode,
        type: isLink ? "symlink" : isDir ? "dir" : "file",
        // Bit 0 is "encrypted"; bit 6 is strong encryption.
        encrypted: (flags & 0x0001) !== 0 || (flags & 0x0040) !== 0,
      });

      p += 46 + nameLen + extraLen + commentLen;
    }

    return new ZipArchive(buf, entries);
  }

  /** Total declared uncompressed bytes. */
  get uncompressedBytes(): number {
    return this.entries.reduce((n, e) => n + e.size, 0);
  }

  /**
   * The listing `artifact.ts` judges. A symlink's target is read here, because "a link to /run/secrets" and "a
   * link to ./dist" are very different events and the verdict should be able to say which.
   */
  listing(): ArchiveEntry[] {
    return this.entries.map((e) => {
      const base: ArchiveEntry = { path: e.path, size: e.size, type: e.type };
      if (e.type !== "symlink") return base;
      let target: string | undefined;
      // A link's target is its (tiny) content. If it will not read, the entry is still reported as a link.
      try { if (e.size <= 4096) target = this.read(e).toString("utf8"); } catch { target = undefined; }
      return { ...base, linkTarget: target };
    });
  }

  /** Decompress one entry, with every size checked. */
  read(entry: ZipEntry): Buffer {
    if (entry.encrypted) throw new ZipError(`"${entry.path}" is encrypted; an artifact must be readable to be checked`);
    if (entry.type === "dir") return Buffer.alloc(0);
    if (entry.size > ZIP_LIMITS.maxFileBytes) {
      throw new ZipError(`"${entry.path}" declares ${Math.round(entry.size / 1024 / 1024)} MB, above the ${ZIP_LIMITS.maxFileBytes / 1024 / 1024} MB per-file limit`);
    }

    const b = this.buf;
    const lo = entry.localOffset;
    if (u32(b, lo) !== SIG_LOCAL) throw new ZipError(`"${entry.path}" does not have a local file header where the central directory says`);
    const nameLen = u16(b, lo + 26);
    const extraLen = u16(b, lo + 28);
    const start = lo + 30 + nameLen + extraLen;

    // The central directory's compressed size is used, never the local header's. A local header claiming a
    // different length is the standard way to make a reader and a scanner disagree about an archive's contents.
    const end = start + entry.compressedSize;
    if (start < 0 || end > b.length) throw new ZipError(`"${entry.path}" declares data outside the file`);
    const raw = b.subarray(start, end);

    let out: Buffer;
    if (entry.method === 0) {
      out = Buffer.from(raw);
    } else if (entry.method === 8) {
      try {
        out = inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(entry.size, ZIP_LIMITS.maxFileBytes)) });
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        throw new ZipError(/maxOutputLength|buffer/i.test(msg)
          ? `"${entry.path}" expands beyond the size it declares (${entry.size} bytes); the archive is not trustworthy`
          : `"${entry.path}" could not be decompressed: ${msg.slice(0, 160)}`);
      }
    } else {
      throw new ZipError(`"${entry.path}" uses compression method ${entry.method}; only stored and deflate are supported`);
    }

    // Both checks matter: the length catches a truncated or padded entry, the CRC catches altered bytes.
    if (out.length !== entry.size) throw new ZipError(`"${entry.path}" unpacked to ${out.length} bytes but declares ${entry.size}`);
    if ((crc32(out) >>> 0) !== (entry.crc >>> 0)) throw new ZipError(`"${entry.path}" failed its checksum; the archive is damaged or was altered`);
    return out;
  }

  /**
   * The text of the files worth reading, for the credential and manifest checks.
   *
   * Only entries `shouldReadAsText` accepts, and only ones with a safe path: reading a traversal entry's content
   * is not dangerous in itself, but there is no reason to spend memory on a file that is already disqualifying.
   */
  textFiles(o: { skip?: (path: string) => boolean } = {}): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of this.entries) {
      if (e.type !== "file" || e.encrypted) continue;
      if (o.skip?.(e.path)) continue;
      if (!shouldReadAsText(e.path, e.size)) continue;
      try { out[e.path] = this.read(e).toString("utf8"); } catch { /* unreadable: the verdict will say so */ }
    }
    return out;
  }

  /** The entry for a path, or null. */
  find(p: string): ZipEntry | null {
    return this.entries.find((e) => e.path === p) ?? null;
  }
}
