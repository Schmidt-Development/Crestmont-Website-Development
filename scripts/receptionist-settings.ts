// The receptionist's operating settings (/staff/voice/operations: hours, holidays, transfer, scheduling, number binding,
// agent id) for production, copied from staging where the Founder configured them (Founder, 2026-11-11: real inbound
// calls reach production with the existing configuration). Used by .github/workflows/production-receptionist-routing.yml.
//
//   export  --out <file>                 staging job: reads staging D1, writes the settings (outbound forced OFF)
//   plan    --in <file> [--apply]        production job: production keeps settings it already has (only field names
//                                        that differ are reported); when it has none, --apply writes the staging copy
// Values are never printed: field names, counts and the last 4 digits of numbers only.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { normalise, voiceConfigProblems, type VoiceConfig } from "../src/services/voice-settings.ts";

/** The staging settings as production gets them: identical, except receptionist follow-up calling is off. */
export function forProduction(raw: unknown): VoiceConfig {
  const c = normalise(raw);
  return { ...c, outbound: { ...c.outbound, enabled: false } };
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
export function insertSql(c: VoiceConfig, now: string): string {
  const json = JSON.stringify(c);
  return `INSERT INTO voice_settings (id, config_json, updated_by, updated_at) VALUES (1, ${q(json)}, NULL, ${q(now)}) ON CONFLICT(id) DO NOTHING;\n`
    + `INSERT INTO audit_logs (actor_kind, action, subject_type, subject_id, details_json, created_at) VALUES ('system', 'voice.settings_copied_from_staging', 'voice_settings', '1', ${q(JSON.stringify({ fields: Object.keys(c), outbound: "off" }))}, ${q(now)});\n`;
}

export function summary(c: VoiceConfig): string[] {
  const days = Object.values(c.hours).filter((w) => w.length).length;
  return [
    `time zone ${c.timezone ? "set" : "not set"}; ${days} open day(s); ${c.holidays.length} holiday(s)`,
    `inbound ${c.inbound.mode}; numbers bound: ${c.inbound.numbers.map((n) => `…${n.replace(/\D/g, "").slice(-4)}`).join(", ") || "none (any number accepted)"}; agent id ${c.inbound.agent_id ?? "not set"}`,
    `transfer ${c.transfer.enabled && c.transfer.number ? "enabled to a configured number" : "off (callback offered)"}; scheduling ${c.scheduling.enabled ? "on" : "off"}; outbound follow-up ${c.outbound.enabled ? "ON" : "off"}`,
  ];
}

function d1(db: string, env: string, sql: string): unknown[] {
  const [cmd, ...base] = (process.env.WRANGLER ?? "npx --yes wrangler@4.149.0").split(" ").filter(Boolean);
  const out = execFileSync(cmd, [...base, "d1", "execute", db, "--remote", "--env", env, "--json", "--command", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  const parsed = JSON.parse(out) as { results?: unknown[] }[];
  return parsed[0]?.results ?? [];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  const opt = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const mode = a[0];
  if (mode === "export") {
    const rows = d1("crestmont-staging", "staging", "SELECT config_json FROM voice_settings WHERE id = 1") as { config_json: string }[];
    if (!rows[0]) { console.log("staging has no receptionist settings recorded; production keeps its defaults"); writeFileSync(opt("--out")!, "null", { mode: 0o600 }); process.exit(0); }
    const c = forProduction(JSON.parse(rows[0].config_json));
    writeFileSync(opt("--out")!, JSON.stringify(c), { mode: 0o600 });
    for (const l of summary(c)) console.log(`staging: ${l}`);
  } else if (mode === "plan") {
    const src = JSON.parse(readFileSync(opt("--in")!, "utf8")) as VoiceConfig | null;
    const rows = d1("crestmont-production", "production", "SELECT config_json FROM voice_settings WHERE id = 1") as { config_json: string }[];
    if (rows[0]) {
      const cur = normalise(JSON.parse(rows[0].config_json));
      const diff = src ? (Object.keys(cur) as (keyof VoiceConfig)[]).filter((k) => JSON.stringify(cur[k]) !== JSON.stringify(src[k])) : [];
      for (const l of summary(cur)) console.log(`production (kept): ${l}`);
      console.log(diff.length ? `production already has its own settings; differs from staging in: ${diff.join(", ")} (kept as the Owner set them)` : "production settings match staging");
      process.exit(0);
    }
    if (!src) { console.log("neither environment has receptionist settings: production answers with the defaults"); process.exit(0); }
    const problems = voiceConfigProblems(src);
    if (problems.length) { console.error(`the staging settings do not validate: ${problems.join(" ")}`); process.exit(1); }
    for (const l of summary(src)) console.log(`to production: ${l}`);
    if (!a.includes("--apply")) { console.log("dry run: nothing was written"); process.exit(0); }
    const file = opt("--sql")!;
    writeFileSync(file, insertSql(src, new Date().toISOString()), { flag: "wx", mode: 0o600 });
    const [cmd, ...base] = (process.env.WRANGLER ?? "npx --yes wrangler@4.149.0").split(" ").filter(Boolean);
    execFileSync(cmd, [...base, "d1", "execute", "crestmont-production", "--remote", "--env", "production", "--file", file, "--yes"], { stdio: ["ignore", "ignore", "pipe"] });
    const back = d1("crestmont-production", "production", "SELECT config_json FROM voice_settings WHERE id = 1") as { config_json: string }[];
    if (!back[0] || JSON.stringify(normalise(JSON.parse(back[0].config_json))) !== JSON.stringify(src)) { console.error("read-back does not match"); process.exit(1); }
    console.log("production receptionist settings written and read back");
  } else { console.error("usage: export --out <f> | plan --in <f> [--apply --sql <f>]"); process.exit(2); }
}
