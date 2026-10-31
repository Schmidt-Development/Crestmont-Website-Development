// Foursquare OS Places (secondary; Apache-2.0, NOTICE must be preserved). OFF by default: releases since October 2025
// need a Places-portal account/token or a gated Hugging Face agreement (which lets Foursquare use the company name and
// logo in its marketing). The Founder decides; then the data is downloaded with that access and this adapter reads the
// local Parquet files (FOURSQUARE_PARQUET_GLOB). It never calls a Foursquare API.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Candidate, SourceAdapter } from "./types.ts";
import { copyAtomic, lit, readJsonLines, type SqlRunner } from "../duckdb.ts";
import { phoneE164, normEmail, normZip } from "../../../src/domain/research.ts";
import { stateCode } from "./us-states.ts";

interface FsqRow { fsq_place_id: string; name: string | null; latitude: number | null; longitude: number | null; address: string | null; locality: string | null; region: string | null; postcode: string | null; tel: string | null; website: string | null; email: string | null; category: string | null; date_refreshed: string | null }

export function fsqCandidate(r: FsqRow, release: string, retrievedAt: string): Candidate | null {
  if (!r.fsq_place_id || !r.name) return null;
  const phone = phoneE164(r.tel);
  const email = normEmail(r.email);
  return {
    businessKey: `foursquare_os:${r.fsq_place_id}`, name: r.name.trim(), category: r.category ?? null,
    address: { line: r.address ?? null, city: r.locality ?? null, state: stateCode(r.region), zip: normZip(r.postcode) },
    lat: r.latitude ?? null, lon: r.longitude ?? null, phones: phone ? [phone] : [], emails: email ? [email] : [], websites: r.website ? [r.website] : [],
    sources: [{ source: "foursquare_os", sourceId: r.fsq_place_id, license: "Apache-2.0", release, retrievedAt }],
    sourceConfidence: null, operatingStatus: null,
  };
}

export class FoursquareSource implements SourceAdapter {
  readonly id = "foursquare_os" as const;
  private readonly db: SqlRunner;
  private readonly glob: string;
  private readonly dataDir: string;
  private release = "local";
  constructor(db: SqlRunner, opts: { parquetGlob: string; dataDir: string }) { this.db = db; this.glob = opts.parquetGlob; this.dataDir = opts.dataDir; }
  async prepare() {
    const m = /dt=(\d{4}-\d{2}-\d{2})/.exec(this.glob);
    this.release = m ? m[1] : "local";
    return { release: this.release };
  }
  async *candidates(state: string): AsyncIterable<Candidate> {
    const dir = join(this.dataDir, "foursquare", this.release);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "us.jsonl"); // one US extract; per-state filtering happens while streaming (FSQ publishes state names, not codes)
    if (!existsSync(file)) {
      await copyAtomic(this.db, `SELECT fsq_place_id, name, latitude, longitude, address, locality, region, postcode, tel, website, email,
          array_to_string(fsq_category_labels, ' | ') AS category, CAST(date_refreshed AS VARCHAR) AS date_refreshed
        FROM read_parquet(${lit(this.glob.replace(/\\/g, "/"))}) WHERE country = 'US' AND date_closed IS NULL`, file, "JSON", 3600_000);
    }
    const at = new Date().toISOString();
    for await (const r of readJsonLines<FsqRow>(file)) { const c = fsqCandidate(r, this.release, at); if (c && c.address.state === state) yield c; }
  }
}
