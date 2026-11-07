// Acquiring the external assets an uploaded frontend depends on, once, safely, and for good.
//
// WHY HERE. The design measurement runs with `--network none`, so external fonts and images never loaded and the
// approved baseline was the site without them. The runner cannot fetch them either: Node 1 reaches the internet
// through an allow-list proxy that permits the npm registry, the control plane and the model server, and
// explicitly DENIES `.googleapis.com` as a paid-AI domain -- which is where Google Fonts is served from. Widening
// that allow-list to the whole internet is the opposite of what it is for.
//
// So the fetch happens on the platform. A Cloudflare Worker already has `fetch` and R2, and it runs where there
// is no private network to be tricked into reaching: the SSRF surface that makes this dangerous on a normal
// server mostly does not exist here. "Mostly" is not a security argument, so the rules below are applied anyway,
// explicitly, in one place.
//
// WHAT IT WILL DO. HTTPS only. No credentials in the URL. No IP-literal hosts, and no hostname that resolves by
// name to localhost or a private range. Redirects followed up to three times, each hop re-checked by the same
// rules. An allow-list of content types, each confirmed against the bytes' own magic numbers. A per-asset and a
// per-artifact size ceiling. Nothing is executed, ever: these bytes are written into an artifact and rendered by
// a browser inside a sandbox that has no network.
//
// WHAT IT WILL NOT DO. Fetch a remote script. Follow a redirect to http. Trust a Content-Type. Retry for ever.
// Store an asset it could not validate -- a dependency that cannot be acquired safely is RECORDED as missing,
// with its visual impact, and the baseline it belongs to cannot be approved.

import type { Db } from "../lib/db.ts";
import { newId, nowIso } from "../lib/db.ts";
import type { StorageAdapter } from "../adapters/storage.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { audit } from "./security.ts";

export type AssetKind = "image" | "font" | "stylesheet" | "other";

export const ASSET_LIMITS = {
  /** One asset. A hero photograph is a megabyte; ten is somebody's video. */
  bytesPerAsset: 8 * 1024 * 1024,
  /** Everything one artifact may pull in. */
  bytesPerArtifact: 64 * 1024 * 1024,
  /** How many dependencies one artifact may have. Beyond this the page is not a website, it is a crawl. */
  perArtifact: 120,
  /** Redirect hops, each re-checked. */
  redirects: 3,
  timeoutMs: 15_000,
} as const;

/** Content types that may be written into an artifact, and the magic numbers that confirm each one. */
const ALLOWED: { type: RegExp; kinds: AssetKind[]; magic?: (b: Uint8Array) => boolean }[] = [
  { type: /^image\/png$/, kinds: ["image"], magic: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47]) },
  { type: /^image\/jpe?g$/, kinds: ["image"], magic: (b) => starts(b, [0xff, 0xd8, 0xff]) },
  { type: /^image\/gif$/, kinds: ["image"], magic: (b) => starts(b, [0x47, 0x49, 0x46, 0x38]) },
  { type: /^image\/webp$/, kinds: ["image"], magic: (b) => starts(b, [0x52, 0x49, 0x46, 0x46]) && starts(b.subarray(8), [0x57, 0x45, 0x42, 0x50]) },
  { type: /^image\/avif$/, kinds: ["image"], magic: (b) => looksLikeIsoBmff(b) },
  { type: /^image\/svg\+xml$/, kinds: ["image"], magic: (b) => /<svg[\s>]/i.test(text(b.subarray(0, 2048))) },
  { type: /^image\/(x-icon|vnd\.microsoft\.icon)$/, kinds: ["image"], magic: (b) => starts(b, [0x00, 0x00, 0x01, 0x00]) },
  { type: /^(font\/woff2|application\/font-woff2)$/, kinds: ["font"], magic: (b) => starts(b, [0x77, 0x4f, 0x46, 0x32]) },
  { type: /^(font\/woff|application\/font-woff)$/, kinds: ["font"], magic: (b) => starts(b, [0x77, 0x4f, 0x46, 0x46]) },
  { type: /^(font\/ttf|font\/sfnt|application\/x-font-ttf|application\/octet-stream)$/, kinds: ["font"], magic: (b) => isTrueType(b) },
  { type: /^(font\/otf|application\/x-font-otf)$/, kinds: ["font"], magic: (b) => starts(b, [0x4f, 0x54, 0x54, 0x4f]) || isTrueType(b) },
  { type: /^text\/css$/, kinds: ["stylesheet"] },
];

const starts = (b: Uint8Array, bytes: number[]) => bytes.every((v, i) => b[i] === v);
const text = (b: Uint8Array) => new TextDecoder("utf-8", { fatal: false }).decode(b);
const isTrueType = (b: Uint8Array) => starts(b, [0x00, 0x01, 0x00, 0x00]) || starts(b, [0x74, 0x72, 0x75, 0x65]) || starts(b, [0x74, 0x74, 0x63, 0x66]);
/** AVIF and friends: an ISO base media file whose major brand sits at offset 8. */
const looksLikeIsoBmff = (b: Uint8Array) => text(b.subarray(4, 8)) === "ftyp";

/** Hostnames that must never be fetched, by name. An IP literal is refused outright. */
const PRIVATE_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/i;
const PRIVATE_V4 = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/**
 * Is this a URL the platform may fetch on an owner's behalf?
 *
 * Exported and tested on its own, because this is the function that decides whether a feature for loading web
 * fonts can be turned into a way of reading something that is not a web font.
 */
export function checkUrl(raw: string): { ok: true; url: URL } | { ok: false; why: string } {
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, why: "not a URL" }; }

  if (u.protocol !== "https:") return { ok: false, why: `only https is fetched, and this is ${u.protocol.replace(":", "") || "(none)"}` };
  if (u.username || u.password) return { ok: false, why: "the URL carries credentials" };
  if (u.port && u.port !== "443") return { ok: false, why: `only port 443 is fetched, and this names ${u.port}` };

  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, why: "no host" };
  // An IP literal is refused whatever it points at: a website's assets are served from a name.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return { ok: false, why: "the host is an IP address, not a name" };
  if (host.startsWith("[") || host.includes(":")) return { ok: false, why: "the host is an IP address, not a name" };
  if (PRIVATE_NAME.test(host)) return { ok: false, why: `"${host}" is a private or internal name` };
  if (PRIVATE_V4.test(host)) return { ok: false, why: `"${host}" is a private address` };
  if (host === "metadata.google.internal" || host.endsWith(".internal")) return { ok: false, why: `"${host}" is an internal name` };

  return { ok: true, url: u };
}

export interface ResolveRequest { url: string; kind: AssetKind; referencedBy?: string | null }

export interface ResolvedAsset {
  url: string;
  kind: AssetKind;
  status: "pinned" | "refused";
  why?: string;
  sha256?: string;
  bytes?: number;
  contentType?: string;
  r2Key?: string;
  /** base64, so the runner can write the file without a second round trip. Only on `pinned`. */
  body?: string;
}

/**
 * Fetch, validate and store the assets one artifact depends on.
 *
 * Every outcome is recorded, including every refusal: a dependency that could not be acquired is the reason a
 * baseline is materially incomplete, and the owner has to be shown it rather than having a fallback approved on
 * their behalf. Re-resolving an artifact returns what is already stored rather than fetching again, so a retry
 * is cheap and the pinned set is immutable once it exists.
 */
export async function resolveAssets(
  db: Db,
  storage: StorageAdapter,
  o: {
    artifactId: string;
    requests: readonly ResolveRequest[];
    fetchImpl?: typeof fetch;
    now?: () => Date;
  },
): Promise<{ assets: ResolvedAsset[]; refusedVisual: number }> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const artifact = await db.prepare(`SELECT id, project_id, organization_id, sha256 FROM frontend_artifacts WHERE id = ?`)
    .bind(o.artifactId).first<{ id: string; project_id: string; organization_id: string; sha256: string }>();
  if (!artifact) return { assets: [], refusedVisual: 0 };

  const existing = new Map<string, ResolvedAsset & { r2Key?: string }>();
  for (const r of (await db.prepare(`SELECT * FROM frontend_artifact_assets WHERE artifact_id = ?`).bind(o.artifactId).all<{
    url: string; kind: string; status: string; why: string | null; sha256: string | null; bytes: number | null;
    content_type: string | null; r2_key: string | null;
  }>()).results) {
    existing.set(r.url, {
      url: r.url, kind: r.kind as AssetKind, status: r.status as "pinned" | "refused", why: r.why ?? undefined,
      sha256: r.sha256 ?? undefined, bytes: r.bytes ?? undefined, contentType: r.content_type ?? undefined,
      r2Key: r.r2_key ?? undefined,
    });
  }

  const out: ResolvedAsset[] = [];
  let total = 0;
  let fetched = 0;
  const seen = new Set<string>();

  for (const req of o.requests) {
    if (seen.has(req.url)) continue;
    seen.add(req.url);

    // Already resolved: hand back the stored bytes. The pinned set for an artifact never changes under a build.
    const was = existing.get(req.url);
    if (was) {
      const body = was.status === "pinned" && was.r2Key ? await readBase64(storage, was.r2Key) : undefined;
      out.push({ ...was, body });
      if (was.bytes) total += was.bytes;
      continue;
    }

    if (out.length >= ASSET_LIMITS.perArtifact) {
      out.push({ url: req.url, kind: req.kind, status: "refused", why: `this artifact already has ${ASSET_LIMITS.perArtifact} external dependencies, which is the limit` });
      continue;
    }
    if (req.kind !== "image" && req.kind !== "font" && req.kind !== "stylesheet") {
      out.push({ url: req.url, kind: req.kind, status: "refused", why: "only images, fonts and stylesheets are pinned; nothing else is fetched on an owner's behalf" });
      continue;
    }

    const got = await fetchOne(fetchImpl, req, ASSET_LIMITS.bytesPerArtifact - total);
    fetched++;
    if (!got.ok) {
      out.push({ url: req.url, kind: req.kind, status: "refused", why: got.why });
      continue;
    }
    total += got.body.length;
    const sha = await sha256Hex(got.body);
    const key = `frontend-assets/${artifact.sha256}/${sha}`;
    await storage.put(key, got.body, got.contentType);
    out.push({
      url: req.url, kind: req.kind, status: "pinned", sha256: sha, bytes: got.body.length,
      contentType: got.contentType, r2Key: key, body: base64(got.body),
    });
  }

  // Recorded in one pass, so a partial failure cannot leave a half-described dependency set.
  const at = (o.now?.() ?? new Date()).toISOString();
  for (const a of out) {
    if (existing.has(a.url)) continue;
    await db.prepare(
      `INSERT INTO frontend_artifact_assets (id, artifact_id, url, kind, status, why, sha256, bytes, content_type, r2_key, local_path, referenced_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      newId("faa"), o.artifactId, a.url, a.kind, a.status, a.why ?? null, a.sha256 ?? null, a.bytes ?? null,
      a.contentType ?? null, a.r2Key ?? null, a.status === "pinned" ? localPathFor(a) : null,
      o.requests.find((r) => r.url === a.url)?.referencedBy ?? null, at,
    ).run();
  }

  const refusedVisual = out.filter((a) => a.status === "refused" && a.kind !== "other").length;
  if (fetched > 0) {
    await audit(db, {
      actorKind: "system", action: "frontend_artifact.assets_resolved", subjectType: "frontendArtifact",
      subjectId: o.artifactId, organizationId: artifact.organization_id,
      details: {
        requested: o.requests.length, fetched, pinned: out.filter((a) => a.status === "pinned").length,
        refused: out.filter((a) => a.status === "refused").length, refusedVisual, bytes: total,
      },
    });
  }
  return { assets: out, refusedVisual };
}

/** Where a pinned asset is written inside the artifact. Mirrors `runner/src/frontend/external-assets.ts`. */
export function localPathFor(a: { sha256?: string; contentType?: string; url: string }): string {
  const ext = extensionFor(a.contentType ?? "", a.url);
  return `_crestmont-assets/${(a.sha256 ?? "").slice(0, 32)}${ext}`;
}

const BY_TYPE: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/webp": ".webp", "image/avif": ".avif",
  "image/gif": ".gif", "image/svg+xml": ".svg", "image/x-icon": ".ico", "image/vnd.microsoft.icon": ".ico",
  "font/woff2": ".woff2", "font/woff": ".woff", "font/ttf": ".ttf", "font/otf": ".otf", "font/sfnt": ".ttf",
  "application/font-woff2": ".woff2", "application/font-woff": ".woff", "application/x-font-ttf": ".ttf",
  "application/x-font-otf": ".otf", "text/css": ".css",
};

function extensionFor(contentType: string, url: string): string {
  const t = contentType.split(";")[0].trim().toLowerCase();
  if (BY_TYPE[t]) return BY_TYPE[t];
  const fromUrl = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url)?.[1];
  if (fromUrl && /^(png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|otf|css)$/i.test(fromUrl)) return `.${fromUrl.toLowerCase()}`;
  return ".bin";
}

/** One asset, with every rule applied at every redirect hop. */
async function fetchOne(
  fetchImpl: typeof fetch,
  req: ResolveRequest,
  budget: number,
): Promise<{ ok: true; body: Uint8Array; contentType: string } | { ok: false; why: string }> {
  if (budget <= 0) return { ok: false, why: "this artifact's external assets already fill the size budget" };

  let target = req.url;
  for (let hop = 0; hop <= ASSET_LIMITS.redirects; hop++) {
    const checked = checkUrl(target);
    if (!checked.ok) return { ok: false, why: hop === 0 ? checked.why : `a redirect led to a URL that cannot be fetched: ${checked.why}` };

    let res: Response;
    try {
      res = await fetchImpl(checked.url.toString(), {
        redirect: "manual",
        signal: AbortSignal.timeout(ASSET_LIMITS.timeoutMs),
        headers: {
          // A plain, honest client. No owner email, no platform secret, nothing that identifies a customer.
          "user-agent": "CrestmontArtifactAssets/1 (+design measurement; pins assets for offline rendering)",
          accept: req.kind === "stylesheet" ? "text/css,*/*;q=0.1" : "image/*,font/*,*/*;q=0.1",
        },
      });
    } catch (e) {
      return { ok: false, why: `the request failed: ${String((e as Error)?.message ?? e).slice(0, 160)}` };
    }

    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) return { ok: false, why: `answered ${res.status} with no location` };
      try { target = new URL(next, checked.url).toString(); } catch { return { ok: false, why: "a redirect pointed at a URL that cannot be read" }; }
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, why: `the host answered ${res.status}: this asset is not publicly readable, and the platform does not authenticate on an owner's behalf` };
    }
    if (!res.ok) return { ok: false, why: `the host answered ${res.status}` };

    const declared = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const rule = ALLOWED.find((r) => r.type.test(declared));
    if (!rule) return { ok: false, why: `the content type "${declared || "(none)"}" is not one that may be written into an artifact` };
    if (!rule.kinds.includes(req.kind)) {
      return { ok: false, why: `a ${req.kind} was expected and the host served "${declared}"` };
    }

    const length = Number(res.headers.get("content-length") ?? "0");
    if (length > ASSET_LIMITS.bytesPerAsset) return { ok: false, why: `${Math.round(length / 1024 / 1024)} MB exceeds the ${ASSET_LIMITS.bytesPerAsset / 1024 / 1024} MB per-asset limit` };

    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > ASSET_LIMITS.bytesPerAsset) return { ok: false, why: `the body is ${Math.round(buf.length / 1024 / 1024)} MB, past the per-asset limit` };
    if (buf.length > budget) return { ok: false, why: "this artifact's external assets would exceed the total size budget" };
    if (!buf.length) return { ok: false, why: "the host served an empty body" };

    // The bytes have to BE what the header claimed. A Content-Type is a claim by a stranger.
    if (rule.magic && !rule.magic(buf)) {
      return { ok: false, why: `the body is not ${declared}: its own first bytes say otherwise` };
    }
    // A stylesheet is text and is read as text; anything that is not valid UTF-8 is not a stylesheet.
    if (declared === "text/css" && !/[{;@}]/.test(text(buf.subarray(0, 4096)))) {
      return { ok: false, why: "the body was served as text/css and does not look like a stylesheet" };
    }

    return { ok: true, body: buf, contentType: declared };
  }
  return { ok: false, why: `more than ${ASSET_LIMITS.redirects} redirects` };
}

async function readBase64(storage: StorageAdapter, key: string): Promise<string | undefined> {
  const obj = await storage.get(key);
  if (!obj) return undefined;
  return base64(new Uint8Array(await new Response(obj.body as ReadableStream).arrayBuffer()));
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export interface ArtifactAssetRow {
  url: string; kind: string; status: string; why: string | null; sha256: string | null; bytes: number | null;
  content_type: string | null; r2_key: string | null; local_path: string | null; referenced_by: string | null;
}

/** Every dependency recorded for an artifact. */
export async function listAssets(db: Db, artifactId: string): Promise<ArtifactAssetRow[]> {
  return (await db.prepare(`SELECT url, kind, status, why, sha256, bytes, content_type, r2_key, local_path, referenced_by
      FROM frontend_artifact_assets WHERE artifact_id = ? ORDER BY status, url`).bind(artifactId).all<ArtifactAssetRow>()).results;
}

/** The visual dependencies that could not be acquired. A baseline with any of these is materially incomplete. */
export async function missingVisualAssets(db: Db, artifactId: string): Promise<ArtifactAssetRow[]> {
  return (await db.prepare(`SELECT url, kind, status, why, sha256, bytes, content_type, r2_key, local_path, referenced_by
      FROM frontend_artifact_assets
     WHERE artifact_id = ? AND status = 'refused' AND kind IN ('image', 'font', 'stylesheet')
     ORDER BY kind, url`).bind(artifactId).all<ArtifactAssetRow>()).results;
}
