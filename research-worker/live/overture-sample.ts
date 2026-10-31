// Writes Overture places for a small bounding box as candidate JSON lines (public open data; no secrets involved).
// Used by deploy-staging.yml so the step that runs the DuckDB package holds no credentials.
//   node --no-warnings research-worker/live/overture-sample.ts --request research-worker/live/staging-e2e-request.json --out e2e/candidates.jsonl
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { DuckDbCli } from "../src/duckdb.ts";
import { OvertureSource, validBbox, type Bbox } from "../src/sources/overture.ts";
import { createLogger } from "../src/log.ts";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const req = JSON.parse(readFileSync(arg("request")!, "utf8")) as { bbox: Bbox; limit: number };
if (!validBbox(req.bbox) || (req.bbox.xmax - req.bbox.xmin) * (req.bbox.ymax - req.bbox.ymin) > 0.05) throw new Error("bbox invalid or too large");
const out = arg("out")!;
mkdirSync(dirname(out), { recursive: true });
const src = new OvertureSource(new DuckDbCli(process.env.DUCKDB_PATH ?? "duckdb", "2GB"), { base: "s3://overturemaps-us-west-2/release", release: process.env.OVERTURE_RELEASE || null, dataDir: dirname(out), log: createLogger({ level: "warn" }) });
const r = await src.sample(req.bbox, join(dirname(out), "overture.jsonl.private"));
// A different deterministic slice each UTC day, so repeated deploys keep exercising new (undecided) businesses.
const day = new Date().toISOString().slice(0, 10);
const rank = (k: string) => createHash("sha256").update(`${day}|${k}`).digest("hex");
const chosen = r.candidates.filter((c) => c.phones.length && !c.brandWikidata).sort((a, b) => rank(a.businessKey).localeCompare(rank(b.businessKey))).slice(0, Math.min(100, Math.max(1, req.limit)));
writeFileSync(out, chosen.map((c) => JSON.stringify(c)).join("\n") + "\n");
console.log(JSON.stringify({ release: r.release, placesInBbox: r.rows, written: chosen.length }));
