// Persistence verification (Founder directive, 2026-11-02, Part 3.3/3.4; failure modes B15-B18, D08, D09, I16).
//
// The defect this exists for, from build bld_d6090c28f8e6923c75223307:
//
//     const ref = generateReference();
//     console.log(`[JTT-quote] ${ref} | name=${data.name} | ...`);
//     return new Response(JSON.stringify({ ok: true, saved: true, reference: ref }), { status: 200 });
//
// A log line and a success claim. No database, no KV, no durable store of any kind -- and the site told visitors
// "Submissions are stored by our system". Every other gate passed.
//
// Two independent checks, because they catch different lies:
//
//   staticPersistenceFindings()  reads the server source. A handler that answers `saved: true` (or any success
//     wording) while its only record of the submission is a console.log is reporting something it did not do. This
//     needs no running server, so it runs in ordinary acceptance.
//
//   verifyPersistence()  is the real proof and needs the Worker running: POST a record carrying a unique marker,
//     then READ IT BACK through an authorized route and require the stored values to match what was sent. An HTTP
//     200 is not persistence; only a read-back is. Used by staging certification, where a server is running.
//
// Honest by construction: a backend that says `saved: false`, or "not connected yet", is NOT a defect here. Run 2's
// Worker did exactly that and was right to. What is a defect is claiming a save that did not happen.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { CheckOutcome } from "./checks.ts";

export interface PersistenceFinding { severity: "error" | "warn"; file: string; message: string }

/** Bindings and APIs that constitute a durable write on the Cloudflare runtime the builds target. */
const DURABLE = [
  /\benv\.[A-Z0-9_]*DB[A-Z0-9_]*\s*\.\s*(prepare|batch|exec)\s*\(/,   // D1
  /\.\s*prepare\s*\([\s\S]{0,200}?\b(insert|update|replace)\b/i,       // D1 SQL
  /\benv\.[A-Z0-9_]+\s*\.\s*put\s*\(/,                                  // KV / R2
  /\bbucket\s*\.\s*put\s*\(/i,
  /\bgetDurableObjectNamespace|DurableObject|\bstate\s*\.\s*storage\s*\.\s*put\s*\(/,
  /\bqueue\s*\.\s*send\s*\(/i,                                          // a queue is a durable handoff
];
/** Calls that look like work but leave no record the business can retrieve. */
const NOT_DURABLE = /\bconsole\s*\.\s*(log|info|warn|debug|error)\s*\(/;

const read = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
const stripComments = (js: string) => js.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

function serverFiles(repo: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth = 0) => {
    if (depth > 5 || !existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && /\.(m?js|ts)$/.test(e.name)) { try { if (statSync(p).size < 1_000_000) out.push(p); } catch { /* vanished */ } }
    }
  };
  walk(path.join(repo, "src"));
  for (const f of ["worker.js", "worker.mjs", "worker.ts", "index.js"]) { const p = path.join(repo, f); if (existsSync(p)) out.push(p); }
  return out;
}

/**
 * Split a server file into handler-sized windows around each success claim, so a durable write somewhere ELSE in the
 * file cannot vouch for a handler that only logs.
 */
function claimWindows(js: string): { claim: string; window: string; index: number }[] {
  const out: { claim: string; window: string; index: number }[] = [];
  // `saved: true`, `stored: true`, `persisted: true` -- an explicit claim that the record is kept.
  for (const m of js.matchAll(/\b(saved|stored|persisted|recorded)\s*:\s*true\b/g)) {
    const i = m.index ?? 0;
    out.push({ claim: m[0], window: js.slice(Math.max(0, i - 1500), i + 400), index: i });
  }
  return out;
}

/**
 * Static reading of the server: a success claim whose handler contains no durable write.
 *
 * Conservative on purpose. It fires only on an EXPLICIT claim (`saved: true` and friends); a handler that returns
 * `{ ok: true }` without asserting storage is not judged here, because "ok" can legitimately mean "accepted".
 */
export function staticPersistenceFindings(repo: string): PersistenceFinding[] {
  const findings: PersistenceFinding[] = [];
  for (const f of serverFiles(repo)) {
    const js = stripComments(read(f));
    const rel = path.relative(repo, f).split(path.sep).join("/");
    for (const { claim, window } of claimWindows(js)) {
      if (DURABLE.some((re) => re.test(window))) continue;          // a real write backs the claim
      const logged = NOT_DURABLE.test(window);
      findings.push({
        severity: "error", file: rel,
        message: `the handler answers \`${claim}\` but nothing in it writes the submission anywhere durable${logged ? " -- its only record is a console log, which no one can retrieve" : ""}. Either store the record (D1, KV, R2 or a queue) or stop claiming it was saved.`,
      });
    }
  }
  return findings;
}

/** Acceptance check wrapper. `null` when the project has no server to judge. */
export function persistenceCheck(repo: string): CheckOutcome | null {
  if (!serverFiles(repo).length) return null;
  const findings = staticPersistenceFindings(repo);
  const errors = findings.filter((f) => f.severity === "error");
  return {
    id: "persistence-check",
    label: "runner: a success claim is backed by a durable write",
    command: "runner: persistence check",
    ok: errors.length === 0,
    code: errors.length === 0 ? 0 : 1,
    timedOut: false,
    outputTail: (errors.length ? errors.map((f) => `ERROR ${f.file}: ${f.message}`).join("\n")
      : "no handler claims to have saved something it did not write").slice(0, 4000),
  };
}

// ── the real proof: write, then read back ─────────────────────────────────────────────────────────────────────────

export interface PersistenceProbe {
  /** Where the record was submitted. */
  endpoint: string;
  submitted: Record<string, string>;
  /** What the server answered. */
  status: number;
  claimedSaved: boolean;
  /** The route the record was read back from, when one could be found. */
  readBackFrom: string | null;
  readBack: boolean;
  /** Values that came back changed or missing. */
  mismatches: string[];
  ok: boolean;
  reason: string;
}

/**
 * Submit a uniquely marked record and require it to come back.
 *
 * `readBack` is supplied by the caller because only it knows how a given project exposes stored records (an admin
 * route, a D1 query, an export). When no read-back is possible the probe FAILS rather than passing on the server's
 * word: an unverifiable claim is exactly the thing this check exists to stop.
 */
export async function verifyPersistence(o: {
  endpoint: string;
  fields: Record<string, string>;
  post: (url: string, body: Record<string, string>) => Promise<{ status: number; body: string }>;
  readBack?: (marker: string) => Promise<{ from: string; record: Record<string, unknown> | null }>;
}): Promise<PersistenceProbe> {
  const marker = `CRESTMONT-PERSIST-${Date.now().toString(36).toUpperCase()}`;
  const fields = { ...o.fields };
  // Put the marker somewhere free-text so it travels with the record and can be found again.
  const slot = Object.keys(fields).find((k) => /message|notes|items|detail|describ|comment/i.test(k)) ?? Object.keys(fields)[0];
  if (slot) fields[slot] = `${fields[slot] ?? ""} ${marker}`.trim();

  const res = await o.post(o.endpoint, fields);
  let claimedSaved = false;
  try {
    const j = JSON.parse(res.body) as Record<string, unknown>;
    claimedSaved = j.saved === true || j.stored === true || j.persisted === true;
  } catch { claimedSaved = /saved|stored|thank|received/i.test(res.body); }

  const base: Omit<PersistenceProbe, "ok" | "reason"> = {
    endpoint: o.endpoint, submitted: fields, status: res.status, claimedSaved,
    readBackFrom: null, readBack: false, mismatches: [],
  };

  if (res.status >= 400) {
    return { ...base, ok: false, reason: `the server rejected the submission (HTTP ${res.status}), so nothing was stored` };
  }
  if (!o.readBack) {
    return { ...base, ok: false, reason: claimedSaved
      ? `the server claims the record was saved, but this project exposes no way to read it back, so the claim cannot be verified and must not be trusted`
      : `the server did not claim to save the record and there is no way to read it back` };
  }

  const got = await o.readBack(marker);
  if (!got.record) {
    return { ...base, readBackFrom: got.from, ok: false, reason: claimedSaved
      ? `the server answered that the record was saved, but reading it back from ${got.from} found nothing. The success message is false.`
      : `the record was not found in ${got.from} after submission` };
  }
  const mismatches: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    const stored = got.record[k];
    if (stored === undefined) { mismatches.push(`${k} was not stored`); continue; }
    if (String(stored).trim() !== String(v).trim()) mismatches.push(`${k} was stored as "${String(stored).slice(0, 60)}" but "${String(v).slice(0, 60)}" was submitted`);
  }
  return {
    ...base, readBackFrom: got.from, readBack: true, mismatches,
    ok: mismatches.length === 0,
    reason: mismatches.length === 0
      ? `the record was written and read back from ${got.from} with every submitted value intact`
      : `the record was stored but ${mismatches.length} value(s) did not survive the round trip`,
  };
}
