// Overture Maps places (primary source). Licence per row: CDLA-Permissive-2.0, Apache-2.0 for Foursquare-sourced
// rows, CC0-1.0 for AllThePlaces rows (docs.overturemaps.org/attribution, verified 2026-10-30). Public bucket, no
// account: s3://overturemaps-us-west-2/release/<release>/theme=places/type=place/*.parquet (GeoParquet).
// One scan per release copies the US subset (projected columns only) to a local Parquet snapshot; per-state work then
// reads the local file. The schema is probed first so a renamed column fails loudly instead of producing empty data.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Candidate, SourceAdapter } from "./types.ts";
import { copyAtomic, csvColumn, lit, readJsonLines, sqlPath, type SqlRunner } from "../duckdb.ts";
import { phoneE164, normEmail, normState, normZip } from "../../../src/domain/research.ts";
import type { Logger } from "../log.ts";

export interface OvertureRow {
  id: string; name: string | null; category: string | null; line: string | null; city: string | null; state: string | null; zip: string | null;
  lat: number | null; lon: number | null; phones: string[] | null; emails: string[] | null; websites: string[] | null; socials: string[] | null;
  confidence: number | null; operating_status: string | null; datasets: string[] | null; licenses: (string | null)[] | null;
  brand?: string | null; brand_wikidata?: string | null;
}

const PREAMBLE = `INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';`;

/** Licence for a row: the row's own declared licence when the release publishes one, otherwise by contributing dataset. */
export function rowLicense(datasets: string[] | null, licenses: (string | null)[] | null): string {
  const declared = (licenses ?? []).filter((l): l is string => typeof l === "string" && /^[A-Za-z0-9.+-]{2,40}$/.test(l));
  if (declared.length) return [...new Set(declared)].join(" + ");
  const ds = (datasets ?? []).join(" ").toLowerCase();
  if (ds.includes("foursquare")) return "Apache-2.0";
  if (ds.includes("alltheplaces")) return "CC0-1.0";
  return "CDLA-Permissive-2.0";
}

/** Builds the snapshot SELECT for the probed schema (column → type). Exported for tests. */
export interface Bbox { xmin: number; ymin: number; xmax: number; ymax: number }
export function validBbox(b: Bbox): boolean {
  return [b.xmin, b.ymin, b.xmax, b.ymax].every((n) => typeof n === "number" && Number.isFinite(n)) && b.xmin < b.xmax && b.ymin < b.ymax && b.xmin >= -180 && b.xmax <= 180 && b.ymin >= -90 && b.ymax <= 90;
}
export function snapshotQuery(base: string, release: string, cols: Map<string, string>, minConfidence: number, bbox?: Bbox): string {
  const need = ["id", "names", "addresses", "phones", "websites", "bbox", "sources"];
  const missing = need.filter((c) => !cols.has(c));
  if (bbox && !validBbox(bbox)) throw new Error("invalid bounding box");
  if (missing.length) throw new Error(`Overture ${release} places schema is missing ${missing.join(", ")}; update research-worker/src/sources/overture.ts`);
  const category = cols.has("basic_category") ? "basic_category" : cols.has("categories") ? "categories.primary" : "NULL";
  const emails = cols.has("emails") ? "emails" : "NULL::VARCHAR[]";
  const socials = cols.has("socials") ? "socials" : "NULL::VARCHAR[]";
  const confidence = cols.has("confidence") ? "confidence" : "NULL::DOUBLE";
  const status = cols.has("operating_status") ? "operating_status" : "NULL::VARCHAR";
  const hasLicense = /license\s+VARCHAR/i.test(cols.get("sources") ?? "");
  const brandType = cols.get("brand") ?? "";
  const brand = /names/i.test(brandType) ? "brand.names.primary" : "NULL::VARCHAR";
  const brandWd = /wikidata/i.test(brandType) ? "brand.wikidata" : "NULL::VARCHAR";
  return `SELECT id, names.primary AS name, ${category} AS category,
      addresses[1].freeform AS line, addresses[1].locality AS city, regexp_replace(addresses[1].region, '^US-', '') AS state, addresses[1].postcode AS zip,
      (bbox.ymin + bbox.ymax) / 2 AS lat, (bbox.xmin + bbox.xmax) / 2 AS lon,
      phones, ${emails} AS emails, websites, ${socials} AS socials, ${confidence} AS confidence, ${status} AS operating_status,
      list_transform(sources, s -> s.dataset) AS datasets, ${hasLicense ? "list_transform(sources, s -> s.license)" : "NULL::VARCHAR[]"} AS licenses,
      ${brand} AS brand, ${brandWd} AS brand_wikidata
    FROM read_parquet(${lit(`${base}/${release}/theme=places/type=place/*.parquet`)}, hive_partitioning = false)
    WHERE len(addresses) > 0 AND addresses[1].country = 'US' AND names.primary IS NOT NULL
      AND coalesce(${confidence}, 1) >= ${minConfidence}
      AND coalesce(${status}, 'open') <> 'permanently_closed'${bbox ? `
      AND bbox.xmin >= ${bbox.xmin} AND bbox.xmax <= ${bbox.xmax} AND bbox.ymin >= ${bbox.ymin} AND bbox.ymax <= ${bbox.ymax}` : ""}`;
}

export function toCandidate(r: OvertureRow, release: string, retrievedAt: string): Candidate | null {
  if (!r.id || !r.name) return null;
  const websites = [...(r.websites ?? []), ...(r.socials ?? [])].filter((w): w is string => typeof w === "string").slice(0, 10);
  return {
    businessKey: `overture:${r.id}`,
    name: r.name.trim(),
    category: r.category ?? null,
    address: { line: r.line ?? null, city: r.city ?? null, state: normState((r.state ?? "").replace(/^US-/i, "")), zip: normZip(r.zip) },
    lat: typeof r.lat === "number" ? r.lat : null, lon: typeof r.lon === "number" ? r.lon : null,
    phones: [...new Set((r.phones ?? []).map(phoneE164).filter((p): p is string => !!p))],
    emails: [...new Set((r.emails ?? []).map(normEmail).filter((e): e is string => !!e))],
    websites,
    sources: [{ source: "overture", sourceId: r.id, license: rowLicense(r.datasets, r.licenses), release, retrievedAt }],
    sourceConfidence: typeof r.confidence === "number" ? r.confidence : null,
    operatingStatus: r.operating_status ?? null,
    datasets: [...new Set((r.datasets ?? []).filter((x): x is string => typeof x === "string" && x.length < 60))].slice(0, 10),
    brand: r.brand ?? null,
    brandWikidata: typeof r.brand_wikidata === "string" && /^Q\d{1,12}$/.test(r.brand_wikidata) ? r.brand_wikidata : null,
  };
}

export class OvertureSource implements SourceAdapter {
  readonly id = "overture" as const;
  private release: string | null = null;
  private readonly db: SqlRunner;
  private readonly opts: { base: string; release: string | null; dataDir: string; minConfidence: number; log: Logger };
  constructor(db: SqlRunner, opts: { base: string; release: string | null; dataDir: string; minConfidence?: number; log: Logger }) {
    this.db = db;
    this.opts = { ...opts, minConfidence: opts.minConfidence ?? 0.5 };
  }

  /** Latest release in the public bucket (listing only), unless one is pinned in configuration. */
  async latestRelease(): Promise<string> {
    if (this.opts.release) return this.opts.release;
    const out = await this.db.exec(`${PREAMBLE}
      SELECT DISTINCT regexp_extract(file, 'release/([0-9]{4}-[0-9]{2}-[0-9]{2}\\.[0-9]+)/', 1) AS r FROM glob(${lit(`${this.opts.base}/*/theme=places/type=place/*`)}) ORDER BY r DESC LIMIT 1;`, { timeoutMs: 300_000 });
    const r = csvColumn(out)[0];
    if (!r || !/^\d{4}-\d{2}-\d{2}\.\d+$/.test(r)) throw new Error("Could not list Overture releases; set OVERTURE_RELEASE (e.g. 2026-10-21.0)");
    return r;
  }

  private dir(release: string) { return join(this.opts.dataDir, "overture", release); }
  snapshotPath(release: string) { return join(this.dir(release), "us_places.parquet"); }

  async prepare(): Promise<{ release: string }> {
    const release = await this.latestRelease();
    this.release = release;
    const target = this.snapshotPath(release);
    if (existsSync(target)) return { release };
    mkdirSync(this.dir(release), { recursive: true });
    const cols = await this.probe(release);
    this.opts.log.info("overture snapshot starting", { release, columns: [...cols.keys()].length });
    // One remote scan (projected columns, US rows) → local ZSTD Parquet. Hours on first run; resumable by re-running.
    await copyAtomic(this.db, snapshotQuery(this.opts.base, release, cols, this.opts.minConfidence), target, "PARQUET", 12 * 3600_000, PREAMBLE)
      .catch((e) => { throw new Error(`Overture snapshot failed: ${(e as Error).message}`); });
    this.opts.log.info("overture snapshot ready", { release, path: target });
    return { release };
  }

  /** Columns of a release, probed from its Parquet schema (name → DuckDB type). */
  async probe(release: string): Promise<Map<string, string>> {
    const describe = await this.db.exec(`${PREAMBLE}
      SELECT column_name || '|' || column_type FROM (DESCRIBE SELECT * FROM read_parquet(${lit(`${this.opts.base}/${release}/theme=places/type=place/*.parquet`)}, hive_partitioning = false));`, { timeoutMs: 600_000 });
    return new Map(csvColumn(describe).map((l) => { const i = l.indexOf("|"); return [l.slice(0, i), l.slice(i + 1)] as [string, string]; }));
  }

  /** Controlled test: places inside a bounding box only (row groups pruned by bbox statistics; no US snapshot). */
  async sample(bbox: Bbox, out: string): Promise<{ release: string; candidates: Candidate[]; rows: number }> {
    const release = await this.latestRelease();
    this.release = release;
    const cols = await this.probe(release);
    await copyAtomic(this.db, snapshotQuery(this.opts.base, release, cols, this.opts.minConfidence, bbox), out, "JSON", 1800_000, PREAMBLE);
    const at = new Date().toISOString();
    const candidates: Candidate[] = [];
    let rows = 0;
    for await (const r of readJsonLines<OvertureRow>(out)) { rows++; const c = toCandidate(r, release, at); if (c) candidates.push(c); }
    return { release, candidates, rows };
  }

  async *candidates(state: string): AsyncIterable<Candidate> {
    if (!this.release) throw new Error("prepare() first");
    const release = this.release;
    const file = join(this.dir(release), `state-${state}.jsonl`);
    if (!existsSync(file)) await copyAtomic(this.db, `SELECT * FROM read_parquet(${sqlPath(this.snapshotPath(release))}) WHERE state = ${lit(state)} ORDER BY id`, file, "JSON", 3600_000);
    const at = new Date().toISOString();
    for await (const r of readJsonLines<OvertureRow>(file)) {
      const c = toCandidate(r, release, at);
      if (c) yield c;
    }
  }
}
