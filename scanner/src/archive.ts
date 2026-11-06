// What a ZIP declares it will expand to, read from its central directory.
//
// WHY THIS EXISTS. The scanner's rule is that bytes ClamAV did not fully examine are never called clean — they are
// `failed` and stay quarantined. That rule was written assuming ClamAV says when it gave up, via
// `Heuristics.Limits.Exceeded.*` under `AlertExceedsMax yes`. Measured against the real daemon
// (clamav/clamav:1.5.1, the pinned image, with the limits scanner/docker-compose.yml sets), it does not:
//
//     40892 bytes   ZIP holding one 40 MB file   -> stream: OK
//    203963 bytes   ZIP holding one 200 MB file  -> stream: OK
//       132 bytes   ZIP with the encrypted flag  -> stream: Heuristics.Encrypted.Zip FOUND
//
// An archive member larger than `MaxFileSize` is SKIPPED, and skipping it does not raise the heuristic. So a
// decompression bomb — tiny on the wire, enormous when opened — came back `clean`, and a file labelled clean is a
// file the design-locked builder will extract and build. The encrypted case works; the size case does not.
//
// Relying on a daemon to report its own blind spot was the mistake. The scanner knows the limits it configured, and a
// ZIP states its own expansion in its central directory, so the scanner can see the blind spot before streaming and
// call it what it is: not fully examined.
//
// Scope, honestly: this reads what the archive DECLARES. A liar can declare a small size and expand further, which is
// why runner/src/frontend/zip.ts independently bounds real inflation with `maxOutputLength` when it extracts. Two
// different jobs: this one decides whether a scan can be trusted, that one decides whether an extraction is safe.
// Together they cover both the honest bomb and the lying one.

/** Zip end-of-central-directory, and the fields of a central-directory entry, at their fixed offsets. */
const EOCD = 0x06054b50, EOCD64_LOCATOR = 0x07064b50, EOCD64 = 0x06064b50, ENTRY = 0x02014b50;
const EOCD_MIN = 22, ENTRY_MIN = 46;
/** A central directory with more entries than this is not walked further; what is read already decides the verdict. */
const MAX_ENTRIES = 20_000;
/** 0xFFFFFFFF in a size field means "see the ZIP64 extra field". */
const ZIP64_MARK = 0xffffffff;

export interface ArchiveSizes {
  /** Entries read from the central directory. */
  entries: number;
  /** Sum of the declared uncompressed sizes. */
  totalUncompressed: number;
  /** The largest single declared uncompressed size. */
  largestUncompressed: number;
  /** A size field this reader could not resolve (a malformed or truncated ZIP64 extra field). */
  indeterminate: boolean;
}

/**
 * The limits scanner/docker-compose.yml configures on the daemon.
 *
 * Used when a caller does not state them, which errs the safe way: if the real daemon is configured MORE generously,
 * the scanner reports `failed` for an archive it would in fact have examined — cautious, and visible in the detail.
 * The opposite default would let a bomb through silently. scanner/src/main.ts always sets them explicitly from the
 * environment, so a deployed scanner never relies on this.
 */
export const DEFAULT_DAEMON_LIMITS: DaemonLimits = { maxFileSizeBytes: 30 * 1024 * 1024, maxScanSizeBytes: 120 * 1024 * 1024 };

/** The daemon's own ceilings, as set on clamd. The scanner's config carries them so the two cannot drift apart. */
export interface DaemonLimits {
  /** clamd `MaxFileSize`: a member larger than this is skipped, silently. */
  maxFileSizeBytes: number;
  /** clamd `MaxScanSize`: total bytes it will examine across the whole archive. */
  maxScanSizeBytes: number;
}

const u32 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | b[at + 3] * 0x1000000;
const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
/** 64-bit little-endian as a JS number. Beyond 2^53 is far past any limit we compare against, so precision is moot. */
const u64 = (b: Uint8Array, at: number) => u32(b, at) + u32(b, at + 4) * 0x100000000;

/** True when the bytes start with a local file header or an empty-archive end record. */
export function looksLikeZip(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07);
}

/**
 * Reads the declared uncompressed sizes from a ZIP's central directory, or null when the bytes are not a ZIP this
 * reader can parse. Never throws and never allocates a copy: a scanner that crashes on a malformed archive is a
 * scanner that stops scanning.
 */
export function archiveSizes(b: Uint8Array): ArchiveSizes | null {
  if (!looksLikeZip(b) || b.length < EOCD_MIN) return null;
  try {
    // The end record is last, after a comment of up to 65535 bytes. Search backwards for it.
    let eocd = -1;
    for (let i = b.length - EOCD_MIN; i >= Math.max(0, b.length - EOCD_MIN - 0xffff); i--) {
      if (u32(b, i) === EOCD) { eocd = i; break; }
    }
    if (eocd < 0) return null;

    let count = u16(b, eocd + 10);
    let start = u32(b, eocd + 16);

    // ZIP64: the 32-bit count/offset saturate and the real values live in the ZIP64 end record.
    if (count === 0xffff || start === ZIP64_MARK) {
      const loc = eocd - 20;
      if (loc >= 0 && u32(b, loc) === EOCD64_LOCATOR) {
        const at = u64(b, loc + 8);
        if (at >= 0 && at + 56 <= b.length && u32(b, at) === EOCD64) {
          count = u64(b, at + 32);
          start = u64(b, at + 48);
        }
      }
    }
    if (!Number.isFinite(start) || start < 0 || start >= b.length) return null;

    const out: ArchiveSizes = { entries: 0, totalUncompressed: 0, largestUncompressed: 0, indeterminate: false };
    let at = start;
    for (let i = 0; i < Math.min(count, MAX_ENTRIES); i++) {
      if (at + ENTRY_MIN > b.length || u32(b, at) !== ENTRY) break;
      const nameLen = u16(b, at + 28), extraLen = u16(b, at + 30), commentLen = u16(b, at + 32);
      let size = u32(b, at + 24);

      if (size === ZIP64_MARK) {
        // The ZIP64 extra field (header id 0x0001) carries the real sizes. Its layout depends on which of the
        // preceding fields saturated, so follow that order: uncompressed, compressed, offset, disk.
        const compressed = u32(b, at + 20);
        let found = false;
        let e = at + ENTRY_MIN + nameLen;
        const extraEnd = Math.min(e + extraLen, b.length);
        while (e + 4 <= extraEnd) {
          const id = u16(b, e), len = u16(b, e + 2);
          if (id === 0x0001 && e + 4 + 8 <= extraEnd) { size = u64(b, e + 4); found = true; break; }
          if (len <= 0) break;
          e += 4 + len;
        }
        // Unresolvable: treat the archive as one whose expansion is unknown rather than guessing small.
        if (!found) { out.indeterminate = true; size = Math.max(compressed, 0); }
      }

      if (!Number.isFinite(size) || size < 0) { out.indeterminate = true; size = 0; }
      out.entries++;
      out.totalUncompressed += size;
      if (size > out.largestUncompressed) out.largestUncompressed = size;
      at += ENTRY_MIN + nameLen + extraLen + commentLen;
    }
    if (count > MAX_ENTRIES) out.indeterminate = true;
    return out.entries ? out : null;
  } catch {
    // Malformed beyond what the guards caught: unknown expansion, which the caller treats as unexaminable.
    return { entries: 0, totalUncompressed: 0, largestUncompressed: 0, indeterminate: true };
  }
}

/**
 * Why the daemon could not fully examine this archive, or null when it can.
 *
 * The returned string goes into the verdict's `detail`, so it names the measured size and the limit it passed,
 * rather than saying only that something was too big.
 */
export function beyondDaemonLimits(b: Uint8Array, limits: DaemonLimits): string | null {
  const a = archiveSizes(b);
  if (!a) return null;
  if (a.largestUncompressed > limits.maxFileSizeBytes) {
    return `an archive member declares ${a.largestUncompressed} bytes uncompressed, beyond the daemon's MaxFileSize of ${limits.maxFileSizeBytes}; clamd skips such a member without reporting it`;
  }
  if (a.totalUncompressed > limits.maxScanSizeBytes) {
    return `the archive declares ${a.totalUncompressed} bytes uncompressed across ${a.entries} entries, beyond the daemon's MaxScanSize of ${limits.maxScanSizeBytes}`;
  }
  if (a.indeterminate) return "the archive's declared sizes could not be read, so the extent of a scan cannot be established";
  return null;
}
