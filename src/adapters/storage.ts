// Private object storage (FILE-001, SEC-003). Production: R2 bucket binding. Development:
// local-disk adapter supplied by the dev server. Bytes are never served directly; downloads go
// through an authorised route that checks tenant access and logs it.

export interface StoredObject { body: ReadableStream | ArrayBuffer | Uint8Array; contentType: string; size: number }

export interface StorageAdapter {
  readonly kind: "r2" | "local-disk";
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}

export interface R2BucketLike {
  put(key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream; size: number; httpMetadata?: { contentType?: string } } | null>;
  delete(key: string): Promise<void>;
}

export class R2Storage implements StorageAdapter {
  readonly kind = "r2" as const;
  private bucket: R2BucketLike;
  constructor(bucket: R2BucketLike) { this.bucket = bucket; }
  async put(key: string, data: Uint8Array, contentType: string) { await this.bucket.put(key, data, { httpMetadata: { contentType } }); }
  async get(key: string) {
    const o = await this.bucket.get(key);
    return o ? { body: o.body, size: o.size, contentType: o.httpMetadata?.contentType ?? "application/octet-stream" } : null;
  }
  async delete(key: string) { await this.bucket.delete(key); }
}

export const UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;

/** Allow-list by extension AND magic bytes. SVG and HTML are refused (script-capable). */
const ALLOWED: Record<string, { type: string; magic?: number[][] }> = {
  pdf: { type: "application/pdf", magic: [[0x25, 0x50, 0x44, 0x46]] },
  png: { type: "image/png", magic: [[0x89, 0x50, 0x4e, 0x47]] },
  jpg: { type: "image/jpeg", magic: [[0xff, 0xd8, 0xff]] },
  jpeg: { type: "image/jpeg", magic: [[0xff, 0xd8, 0xff]] },
  webp: { type: "image/webp", magic: [[0x52, 0x49, 0x46, 0x46]] },
  gif: { type: "image/gif", magic: [[0x47, 0x49, 0x46, 0x38]] },
  docx: { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", magic: [[0x50, 0x4b, 0x03, 0x04]] },
  xlsx: { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", magic: [[0x50, 0x4b, 0x03, 0x04]] },
  zip: { type: "application/zip", magic: [[0x50, 0x4b, 0x03, 0x04]] },
  txt: { type: "text/plain" },
  csv: { type: "text/csv" },
};

export function validateUpload(filename: string, bytes: Uint8Array): { ok: true; contentType: string; ext: string } | { ok: false; reason: string } {
  if (bytes.length === 0) return { ok: false, reason: "File is empty" };
  if (bytes.length > UPLOAD_LIMIT_BYTES) return { ok: false, reason: "File exceeds the 25 MB limit" };
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const rule = ALLOWED[ext];
  if (!rule) return { ok: false, reason: `File type .${ext} is not allowed` };
  if (rule.magic && !rule.magic.some((m) => m.every((b, i) => bytes[i] === b))) return { ok: false, reason: "File contents do not match its extension" };
  if (!rule.magic) {
    const head = new TextDecoder().decode(bytes.slice(0, 512)).toLowerCase();
    if (head.includes("<script") || head.includes("<html") || bytes.slice(0, 4096).includes(0)) return { ok: false, reason: "Text file contains disallowed content" };
  }
  return { ok: true, contentType: rule.type, ext };
}

export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  return base.replace(/[^\w.\- ()]/g, "_").slice(0, 150) || "file";
}
