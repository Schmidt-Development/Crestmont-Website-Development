// OpenStreetMap via Geofabrik US state extracts (ODbL-1.0, © OpenStreetMap contributors). OFF by default: records
// derived from OSM may be used INSIDE Crestmont only (CRM work); combining them with other data forms a Derivative
// Database, and any Public Use (sharing outside Crestmont) triggers ODbL share-alike. Geofabrik asks users to download
// only what they need; the operator places <state>-latest.osm.pbf files in OSM_PBF_DIR (see docs/research/RUNBOOK.md)
// and this adapter filters them locally with osmium-tool (free). It never downloads automatically.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Candidate, SourceAdapter } from "./types.ts";
import { readJsonLines } from "../duckdb.ts";
import { phoneE164, normEmail, normZip } from "../../../src/domain/research.ts";
import { GEOFABRIK_STEM } from "./us-states.ts";

/** Business-like features only: shops, offices, crafts, and service amenities (not benches or post boxes). */
export const OSM_FILTER = ["nwr/shop", "nwr/office", "nwr/craft", "nwr/healthcare",
  "nwr/amenity=restaurant,cafe,bar,pub,fast_food,dentist,doctors,clinic,veterinary,pharmacy,car_wash,car_rental,fuel,bank,childcare,kindergarten,driving_school,beauty",
  "nwr/leisure=fitness_centre,sports_centre", "nwr/tourism=hotel,motel,guest_house"];

interface Feature { type: "Feature"; id?: string | number; properties: Record<string, string>; geometry: { type: string; coordinates: unknown } }

function firstCoord(g: Feature["geometry"]): [number, number] | null {
  let c: unknown = g?.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number" ? [c[0], c[1]] : null;
}

export function osmCandidate(f: Feature, state: string, release: string, retrievedAt: string): Candidate | null {
  const t = f.properties ?? {};
  const id = String(t["@type"] ? `${String(t["@type"])[0]}${t["@id"]}` : f.id ?? "");
  if (!/^[nwr]\d+$/.test(id) || !t.name) return null;
  const phones = [t.phone, t["contact:phone"]].flatMap((p) => (p ?? "").split(";")).map(phoneE164).filter((p): p is string => !!p);
  const emails = [t.email, t["contact:email"]].map(normEmail).filter((e): e is string => !!e);
  const xy = firstCoord(f.geometry);
  const line = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ") || null;
  return {
    businessKey: `osm_geofabrik:${id}`, name: t.name.trim(),
    category: t.shop ? `shop=${t.shop}` : t.office ? `office=${t.office}` : t.craft ? `craft=${t.craft}` : t.amenity ? `amenity=${t.amenity}` : t.healthcare ? `healthcare=${t.healthcare}` : t.leisure ? `leisure=${t.leisure}` : t.tourism ? `tourism=${t.tourism}` : null,
    address: { line, city: t["addr:city"] ?? null, state: (t["addr:state"] ?? state).toUpperCase().slice(0, 2), zip: normZip(t["addr:postcode"]) },
    lat: xy ? xy[1] : null, lon: xy ? xy[0] : null,
    phones: [...new Set(phones)], emails: [...new Set(emails)], websites: [t.website, t["contact:website"], t.url].filter((w): w is string => !!w),
    sources: [{ source: "osm_geofabrik", sourceId: id, license: "ODbL-1.0", release, retrievedAt }],
    sourceConfidence: null, operatingStatus: t["disused:shop"] || t["abandoned:shop"] ? "permanently_closed" : null,
  };
}

function run(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    const timer = setTimeout(() => { p.kill(); reject(new Error(`${bin} timed out`)); }, timeoutMs);
    p.stderr.on("data", (d) => { if (err.length < 5000) err += d; });
    p.on("error", (e) => { clearTimeout(timer); reject(new Error(`cannot start ${bin}: ${e.message}`)); });
    p.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}: ${err.trim()}`)); });
  });
}

export class OsmSource implements SourceAdapter {
  readonly id = "osm_geofabrik" as const;
  private readonly opts: { osmiumPath: string; pbfDir: string; dataDir: string };
  constructor(opts: { osmiumPath: string; pbfDir: string; dataDir: string }) { this.opts = opts; }
  async prepare() { return { release: new Date().toISOString().slice(0, 10) }; }
  async *candidates(state: string): AsyncIterable<Candidate> {
    const stem = GEOFABRIK_STEM(state);
    const pbf = stem ? join(this.opts.pbfDir, `${stem}-latest.osm.pbf`) : null;
    if (!pbf || !existsSync(pbf)) return; // operator has not placed this state's extract; nothing to read
    const dir = join(this.opts.dataDir, "osm"); mkdirSync(dir, { recursive: true });
    const filtered = join(dir, `${state}-business.osm.pbf`), out = join(dir, `${state}.geojsonseq`);
    await run(this.opts.osmiumPath, ["tags-filter", pbf, ...OSM_FILTER, "-o", filtered, "--overwrite"], 3600_000);
    if (existsSync(`${out}.tmp`)) rmSync(`${out}.tmp`);
    await run(this.opts.osmiumPath, ["export", filtered, "-f", "geojsonseq", "--add-unique-id=type_id", "-x", "print_record_separator=false", "-o", `${out}.tmp`, "--overwrite"], 3600_000);
    renameSync(`${out}.tmp`, out);
    const at = new Date().toISOString(), release = at.slice(0, 10);
    for await (const f of readJsonLines<Feature>(out)) { const c = osmCandidate(f, state, release, at); if (c) yield c; }
  }
}
