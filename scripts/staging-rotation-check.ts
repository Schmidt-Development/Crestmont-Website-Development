// Proves, over real HTTP on the live (public) staging site, that a credential rotation actually revoked the old access.
//
//   capture (BEFORE scripts/staging-access.ts rotates): derives the credentials that are live right now, confirms the
//     live site accepts them and signs the demo Owner in (keeping that session). Writes them to a 0600 state file on the
//     runner only. Does nothing when no rotation is pending.
//   verify (AFTER the rotation and the new-access check): the old Owner password and old session must be rejected; the
//     new password must sign in; no demo recovery code or pending demo invitation may remain.
//
// MFA was removed for every account (Founder directive, 2026-11-06): the password is the whole sign-in, so there is no
// 2FA key or recovery code to prove revoked over HTTP. (A rotation still deletes stored demo recovery codes.)
//
// Every value is registered with ::add-mask:: and none is printed, logged, summarised or uploaded. Output = check names
// with PASS/FAIL only. Staging only (wranglerOps addresses crestmont-staging --env staging).
//
//   node --no-warnings scripts/staging-rotation-check.ts capture --url <url> --state <file>
//     env: ACCESS_ROOT_KEY, ACCESS_EPOCH, ROTATE
//   node --no-warnings scripts/staging-rotation-check.ts verify --url <url> --state <file> --access access/access.json
import { existsSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { currentAccess, rotationPending, wranglerOps, annotation, DEMO_DOMAIN, type AccessResult, type D1Ops } from "./staging-access.ts";
import { passphraseProblem } from "./seal.ts";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Sleep = (ms: number) => Promise<void>;
/** `totp` is the stored demo setup key (still derived by staging-access.ts); it is masked but never used to sign in. */
export interface Owner { email: string; password: string; totp?: string | null }
export interface CaptureState { oldOwner: Owner; sessionCookie: string | null; notes: string[] }
export interface Check { name: string; ok: boolean; detail?: string }

const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A minimal browser: cookie jar, manual redirects, form posts with CSRF and Origin. */
export class Client {
  jar = new Map<string, string>();
  private base: string;
  private f: Fetch;
  private sleep: Sleep;
  constructor(base: string, f: Fetch, sleep: Sleep = realSleep) { this.base = base.replace(/\/$/, ""); this.f = f; this.sleep = sleep; }
  async send(method: string, path: string, form?: Record<string, string>): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { "user-agent": "crestmont-rotation-check" };
      if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
      let body: string | undefined;
      if (form) { body = new URLSearchParams(form).toString(); headers["content-type"] = "application/x-www-form-urlencoded"; headers.origin = new URL(this.base).origin; }
      const res = await this.f(this.base + path, { method, headers, body, redirect: "manual" });
      for (const c of res.headers.getSetCookie()) {
        const [pair, ...attrs] = c.split(";");
        const i = pair.indexOf("=");
        const name = pair.slice(0, i).trim();
        if (attrs.some((a) => a.trim().toLowerCase() === "max-age=0")) this.jar.delete(name); else this.jar.set(name, decodeURIComponent(pair.slice(i + 1).trim()));
      }
      if (res.status !== 429 || attempt >= 2) return res;
      await res.arrayBuffer();
      await this.sleep(20_000);
    }
  }
  loc(r: Response) { return new URL(r.headers.get("location") ?? "/", this.base).pathname; }
  csrf() { return this.jar.get("__Host-cm_csrf") ?? this.jar.get("cm_csrf") ?? ""; }
  /** Email + password (the whole sign-in); true when it lands in the staff area. */
  async password(email: string, password: string): Promise<boolean> {
    let r = await this.send("GET", "/login"); await r.arrayBuffer();
    r = await this.send("POST", "/login", { _csrf: this.csrf(), email, password }); await r.arrayBuffer();
    return r.status === 303 && this.loc(r).startsWith("/staff");
  }
  async signedIn(): Promise<boolean> {
    const r = await this.send("GET", "/staff"); await r.arrayBuffer();
    return r.status === 200;
  }
  async logout() { const r = await this.send("POST", "/logout", { _csrf: this.csrf() }); await r.arrayBuffer(); }
}

const mask = (v: string | null | undefined, out: (s: string) => void) => { if (v) out(`::add-mask::${v}`); };

export async function capture(o: { base: string; ops: D1Ops; rootKey: string; epoch: string; rotate: boolean; f?: Fetch; sleep?: Sleep; out?: (s: string) => void }): Promise<CaptureState | null> {
  const out = o.out ?? console.log, sleep = o.sleep ?? realSleep;
  if (!(await rotationPending(o.ops, { epoch: o.epoch, rotate: o.rotate }))) return null;
  const cur = await currentAccess(o.ops, o.rootKey);
  if (!cur) throw new Error("no current access to capture (staging has never been issued access)");
  for (const v of [cur.owner.password, cur.owner.totp]) mask(v, out);
  const notes: string[] = [];
  const c = new Client(o.base, o.f ?? fetch, sleep);
  if (!(await c.password(cur.owner.email, cur.owner.password))) {
    notes.push("the current Owner credentials were not accepted before the rotation (not testable)");
    return { oldOwner: cur.owner, sessionCookie: null, notes };
  }
  const sessionCookie = c.jar.get("__Host-cm_session") ?? c.jar.get("cm_session") ?? null;
  mask(sessionCookie, out);
  return { oldOwner: cur.owner, sessionCookie, notes };
}

export async function verify(o: { base: string; ops: D1Ops; state: CaptureState; access: AccessResult; f?: Fetch; sleep?: Sleep; out?: (s: string) => void }): Promise<Check[]> {
  const f = o.f ?? fetch, sleep = o.sleep ?? realSleep;
  const owner = o.access.accounts.find((a) => a.role === "owner");
  if (!owner?.password) throw new Error("no new Owner credentials in the access file");
  const s = o.state, checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  const fresh = () => new Client(o.base, f, sleep);

  // Old session (the site is public, so only the session cookie decides).
  if (s.sessionCookie) {
    const old = fresh();
    old.jar.set("cm_session", s.sessionCookie);
    add("Old Owner session invalid", !(await old.signedIn()));
  } else add("Old Owner session invalid", false, "not testable: no session was captured");

  // Passwords.
  if (s.oldOwner.password === owner.password) add("Old Owner password rejected", false, "the Owner password did not change");
  else { const p = fresh(); add("Old Owner password rejected", !(await p.password(s.oldOwner.email, s.oldOwner.password))); }
  const a = fresh();
  const newOk = await a.password(owner.email, owner.password);
  add("New Owner password accepted", newOk);
  if (newOk) await a.logout();

  // Nothing left behind: no demo recovery codes (the rotation deletes them), no pending demo invitations.
  const n = async (sql: string) => Number((await o.ops.query<{ n: number }>(sql))[0]?.n ?? 0);
  add("No demo recovery codes remain", (await n(`SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@${DEMO_DOMAIN}')`)) === 0);
  add("No pending invitations from demo accounts", (await n(`SELECT COUNT(*) AS n FROM invitations WHERE accepted_at IS NULL AND expires_at > '${new Date().toISOString()}' AND invited_by IN (SELECT id FROM users WHERE email LIKE '%@${DEMO_DOMAIN}')`)) === 0);
  return checks;
}

/**
 * Before anything changes: when a rotation is pending, the Founder must be able to receive the new credentials (a usable
 * ACCESS_ARTIFACT_PASSPHRASE). Prints no value.
 */
export async function gate(o: { ops: D1Ops; epoch: string; rotate: boolean; passphrase?: string }): Promise<{ pending: boolean; problems: string[] }> {
  const pending = await rotationPending(o.ops, { epoch: o.epoch, rotate: o.rotate });
  if (!pending) return { pending, problems: [] };
  const p = passphraseProblem(o.passphrase);
  return { pending, problems: p ? [`${p}: the rotated Owner credentials could not be delivered to the Founder`] : [] };
}

/**
 * READ-ONLY, every deploy: the last rotation is complete in D1. Needs no credential, so it also covers a run where the
 * HTTP revocation proof could not run (deploy #56: the rotation succeeded, the new-access check failed before the proof).
 */
export async function rotationState(ops: D1Ops, epoch: string): Promise<Check[]> {
  const meta = Object.fromEntries((await ops.query<{ key: string; value: string }>(`SELECT key, value FROM _staging_access`).catch(() => [])).map((r) => [r.key, r.value]));
  const at = meta.rotated_at ?? "";
  const demo = `(SELECT id FROM users WHERE email LIKE '%@${DEMO_DOMAIN}')`;
  const n = async (sql: string) => Number((await ops.query<{ n: number }>(sql))[0]?.n ?? 0);
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  add(`Access epoch is ${epoch}`, meta.epoch === epoch, meta.epoch ? `D1 holds epoch ${meta.epoch}` : "no access issued yet");
  if (!at) { add("Rotation recorded", false, "no rotated_at in D1"); return checks; }
  add("Rotation audited", (await n(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'staging.access_rotated' AND subject_id = '${epoch.replace(/'/g, "")}'`)) > 0);
  add("No demo session from before the rotation", (await n(`SELECT COUNT(*) AS n FROM sessions WHERE user_id IN ${demo} AND created_at < '${at}'`)) === 0);
  add("No demo one-time token from before the rotation", (await n(`SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id IN ${demo} AND created_at < '${at}'`)) === 0);
  add("No demo recovery code from before the rotation", (await n(`SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id IN ${demo} AND created_at < '${at}'`)) === 0);
  return checks;
}

export const report = (checks: Check[]) => ["| Check | Result |", "|---|---|", ...checks.map((c) => `| ${c.name} | ${c.ok ? "PASS" : "**FAIL**"}${c.detail ? ` (${c.detail})` : ""} |`)].join("\n");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const mode = process.argv[2], url = arg("--url"), stateFile = arg("--state");
  try {
    if (mode === "gate") {
      const g = await gate({ ops: wranglerOps(), epoch: process.env.ACCESS_EPOCH ?? "1", rotate: process.env.ROTATE === "true", passphrase: process.env.ACCESS_ARTIFACT_PASSPHRASE });
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `pending=${g.pending}\n`);
      if (g.problems.length) {
        for (const p of g.problems) console.error(`::error title=Rotation blocked (nothing was changed)::${p}`);
        process.exit(1);
      }
      console.log(g.pending ? "Rotation pending: secure delivery is configured for the new Owner credentials." : "No rotation pending.");
      process.exit(0);
    }
    if (mode === "state") {
      const checks = await rotationState(wranglerOps(), process.env.ACCESS_EPOCH ?? "1");
      const table = report(checks);
      console.log(table);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Rotation state in D1 (read-only)\n\n${table}\n`);
      if (checks.some((c) => !c.ok)) { console.error("::error title=Rotation incomplete::See the step summary (no values are shown)."); process.exit(1); }
      process.exit(0);
    }
    if (!url || !stateFile) throw new Error("--url and --state are required");
    if (mode === "capture") {
      const st = await capture({ base: url, ops: wranglerOps(), rootKey: process.env.ACCESS_ROOT_KEY ?? "", epoch: process.env.ACCESS_EPOCH ?? "1", rotate: process.env.ROTATE === "true" });
      if (!st) { console.log("No rotation pending: old-credential checks are not needed for this run."); process.exit(0); }
      writeFileSync(stateFile, JSON.stringify(st), { mode: 0o600 });
      console.log(`Captured the pre-rotation access for the revocation checks${st.notes.length ? ` (${st.notes.join("; ")})` : ""}.`);
    } else if (mode === "verify") {
      if (!existsSync(stateFile)) { console.log("No captured pre-rotation access: nothing to verify."); process.exit(0); }
      const state = JSON.parse(readFileSync(stateFile, "utf8")) as CaptureState;
      rmSync(stateFile, { force: true });
      const access = JSON.parse(readFileSync(arg("--access") ?? "access/access.json", "utf8")) as AccessResult;
      const checks = await verify({ base: url, ops: wranglerOps(), state, access });
      const table = report(checks);
      console.log(table);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Credential rotation: old access revoked, new access works\n\n${table}\n`);
      if (checks.some((c) => !c.ok)) { console.error("::error title=Rotation verification failed::See the step summary (no values are shown)."); process.exit(1); }
    } else throw new Error("usage: capture|verify --url <url> --state <file> [--access <file>]");
  } catch (e) {
    console.error(`::error::Rotation check failed: ${annotation(e)}`);
    process.exit(1);
  }
}
