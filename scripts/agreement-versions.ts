// Agreement drift check / new-version generator (LEGAL-003).
//
//   node --no-warnings scripts/agreement-versions.ts            # exit 1 and list documents whose text changed
//   node --no-warnings scripts/agreement-versions.ts --sql VER  # print INSERT rows for the changed documents as version VER
//   node --no-warnings scripts/agreement-versions.ts --all VER  # print INSERT rows for every document (initial seed)
//
// Renders each policy in src/content/legal.ts with the default facts (no business settings) and
// compares its SHA-256 to the latest version stored by the migrations (fresh in-memory database).
// When legal copy changes, put the printed SQL in a NEW migration; never edit an applied one.
import { openDb } from "../dev/sqlite-d1.ts";
import { agreementDrift, factsFromSettings, renderAll, versionInsertSql } from "../src/services/agreements.ts";

const args = process.argv.slice(2);
const facts = factsFromSettings({});
const effectiveAt = new Date().toISOString();

if (args[0] === "--all") {
  const version = args[1];
  if (!version) throw new Error("Usage: --all <version>");
  const rows = await renderAll(facts);
  process.stdout.write(versionInsertSql(rows.map((r) => ({ kind: r.kind, version, title: r.title, text: r.text, sha256: r.sha256, effectiveAt }))));
} else {
  const db = openDb(":memory:");
  const drift = await agreementDrift(db, facts);
  if (args[0] === "--sql") {
    const version = args[1];
    if (!version) throw new Error("Usage: --sql <version>");
    const rendered = new Map((await renderAll(facts)).map((r) => [r.kind, r]));
    process.stdout.write(drift.length ? versionInsertSql(drift.map((d) => { const r = rendered.get(d.kind)!; return { kind: r.kind, version, title: r.title, text: r.text, sha256: r.sha256, effectiveAt }; })) : "-- no drift\n");
  } else if (drift.length) {
    for (const d of drift) console.error(`DRIFT ${d.kind}: stored ${d.storedVersion ?? "none"} (${d.storedSha?.slice(0, 12) ?? "-"}) != current ${d.currentSha.slice(0, 12)}`);
    console.error("Create a new migration with: node --no-warnings scripts/agreement-versions.ts --sql <new-version>");
    process.exit(1);
  } else console.log("All agreement versions match the current legal content.");
}
