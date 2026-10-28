// Proves, over real HTTP on the live staging preview, that a credential rotation actually revoked the old access.
//
//   capture (BEFORE scripts/staging-access.ts rotates): derives the credentials that are live right now, confirms the
//     live site accepts them, signs the demo Owner in (keeping that session) and mints one recovery code. Writes them to
//     a 0600 state file on the runner only. Does nothing when no rotation is pending.
//   verify (AFTER the rotation and the new-access check): old preview password, old Owner password, old 2FA key, old
//     recovery code and old session must all be rejected; the new preview password, password and 2FA key must work; the
//     recovery-code mechanism must work end to end (generate with a fresh 2FA code → sign in with one code). Then deletes
//     the codes it generated (nobody holds them) and confirms no demo recovery code or pending demo invitation remains.
//
// Every value is registered with ::add-mask:: and none is printed, logged, summarised or uploaded. Output = check names
// with PASS/FAIL only. Staging only (wranglerOps addresses crestmont-staging --env staging).
//
//   node --no-warnings scripts/staging-rotation-check.ts capture --url <url> --state <file>
//     env: ACCESS_ROOT_KEY, ACCESS_EPOCH, ROTATE, FIXED_PREVIEW_PASSWORD
//   node --no-warnings scripts/staging-rotation-check.ts verify --url <url> --state <file> --access access/access.json
import { existsSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { totpCode } from "../src/lib/auth-crypto.ts";
import { currentAccess, rotationPending, wranglerOps, DEMO_DOMAIN, type AccessResult, type D1Ops } from "./staging-access.ts";
import { secretFingerprint } from "./staging-secrets.ts";
import { passphraseProblem } from "./seal.ts";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Sleep = (ms: number) => Promise<void>;
export interface Owner { email: string; password: string; totp: string }
export interface CaptureState { oldPreview: string | null; oldOwner: Owner; sessionCookie: string | null; oldRecoveryCode: string | null; notes: string[] }
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
  csrf() { return this.jar.get("cm_csrf") ?? ""; }
  async gate(password: string): Promise<boolean> {
    const r = await this.send("POST", "/__preview-access", { password, next: "/login" });
    await r.arrayBuffer();
    return r.status === 303 && this.jar.has("cm_preview");
  }
  /** Email + password; true when the site asks for the second factor. */
  async password(email: string, password: string): Promise<boolean> {
    let r = await this.send("GET", "/login"); await r.arrayBuffer();
    r = await this.send("POST", "/login", { _csrf: this.csrf(), email, password }); await r.arrayBuffer();
    return r.status === 303 && this.loc(r).startsWith("/mfa");
  }
  /** Second factor (TOTP or recovery code); true when it lands in the staff area. */
  async second(code: string): Promise<boolean> {
    const r = await this.send("POST", "/mfa", { _csrf: this.csrf(), code }); await r.arrayBuffer();
    return r.status === 303 && this.loc(r).startsWith("/staff");
  }
  async signedIn(): Promise<boolean> {
    const r = await this.send("GET", "/staff"); await r.arrayBuffer();
    return r.status === 200;
  }
  async logout() { const r = await this.send("POST", "/logout", { _csrf: this.csrf() }); await r.arrayBuffer(); }
}

/** Each TOTP step is accepted once and never an earlier one: always use a step that starts after now. */
export async function freshTotp(secret: string, sleep: Sleep, now: () => number = Date.now): Promise<string> {
  const ms = now();
  await sleep(30_000 - (ms % 30_000) + 1_500);
  return totpCode(secret);
}

export async function generateRecoveryCodes(c: Client, totp: string, sleep: Sleep): Promise<string[]> {
  let r = await c.send("GET", "/account"); await r.arrayBuffer();
  r = await c.send("POST", "/account/mfa/recovery-codes", { _csrf: c.csrf(), code: await freshTotp(totp, sleep) });
  const page = await r.text();
  if (r.status !== 200) return [];
  const list = /data-testid="recovery-codes"[^>]*>([\s\S]*?)<\/ol>/.exec(page)?.[1] ?? "";
  return [...list.matchAll(/<code>([^<]+)<\/code>/g)].map((m) => m[1].trim());
}

const mask = (v: string | null | undefined, out: (s: string) => void) => { if (v) out(`::add-mask::${v}`); };

export async function capture(o: { base: string; ops: D1Ops; rootKey: string; epoch: string; rotate: boolean; fixedPreview?: string; f?: Fetch; sleep?: Sleep; out?: (s: string) => void }): Promise<CaptureState | null> {
  const out = o.out ?? console.log, sleep = o.sleep ?? realSleep;
  if (!(await rotationPending(o.ops, { epoch: o.epoch, rotate: o.rotate }))) return null;
  const cur = await currentAccess(o.ops, o.rootKey, o.fixedPreview);
  if (!cur) throw new Error("no current access to capture (staging has never been issued access)");
  for (const v of [...cur.previewCandidates, cur.owner.password, cur.owner.totp]) mask(v, out);
  const notes: string[] = [];
  const c = new Client(o.base, o.f ?? fetch, sleep);
  let oldPreview: string | null = null;
  for (const p of cur.previewCandidates) if (await c.gate(p)) { oldPreview = p; break; }
  if (!oldPreview) { notes.push("the live preview password could not be derived (not testable)"); return { oldPreview, oldOwner: cur.owner, sessionCookie: null, oldRecoveryCode: null, notes }; }
  if (!(await c.password(cur.owner.email, cur.owner.password)) || !(await c.second(await freshTotp(cur.owner.totp, sleep)))) {
    notes.push("the current Owner credentials were not accepted before the rotation (not testable)");
    return { oldPreview, oldOwner: cur.owner, sessionCookie: null, oldRecoveryCode: null, notes };
  }
  const sessionCookie = c.jar.get("cm_session") ?? null;
  const codes = await generateRecoveryCodes(c, cur.owner.totp, sleep);
  for (const v of [sessionCookie, ...codes]) mask(v, out);
  if (!codes.length) notes.push("no recovery code could be generated before the rotation");
  return { oldPreview, oldOwner: cur.owner, sessionCookie, oldRecoveryCode: codes[0] ?? null, notes };
}

export async function verify(o: { base: string; ops: D1Ops; state: CaptureState; access: AccessResult; f?: Fetch; sleep?: Sleep; out?: (s: string) => void }): Promise<Check[]> {
  const f = o.f ?? fetch, sleep = o.sleep ?? realSleep, out = o.out ?? console.log;
  const owner = o.access.accounts.find((a) => a.role === "owner");
  if (!owner?.totp) throw new Error("no new Owner credentials in the access file");
  const s = o.state, checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  const fresh = () => new Client(o.base, f, sleep);

  // Preview password.
  if (s.oldPreview === null) add("Old preview password rejected", false, "not testable: " + s.notes.join("; "));
  else if (s.oldPreview === o.access.previewPassword) add("Old preview password rejected", false, "the preview password did not change (a STAGING_PREVIEW_PASSWORD override was left in place)");
  else add("Old preview password rejected", !(await fresh().gate(s.oldPreview)));
  const c = fresh();
  add("New preview password accepted", await c.gate(o.access.previewPassword));

  // Old session (behind the NEW preview cookie, so only the session decides).
  if (s.sessionCookie) {
    const old = fresh();
    old.jar.set("cm_preview", c.jar.get("cm_preview") ?? "");
    old.jar.set("cm_session", s.sessionCookie);
    add("Old Owner session invalid", !(await old.signedIn()));
  } else add("Old Owner session invalid", false, "not testable: no session was captured");

  // Passwords.
  if (s.oldOwner.password === owner.password) add("Old Owner password rejected", false, "the Owner password did not change");
  else { const p = fresh(); p.jar = new Map(c.jar); add("Old Owner password rejected", !(await p.password(s.oldOwner.email, s.oldOwner.password))); }
  const a = fresh(); a.jar = new Map(c.jar);
  add("New Owner password accepted (2FA requested)", await a.password(owner.email, owner.password));

  // Second factor: old recovery code and old 2FA key first, then the new key.
  if (s.oldRecoveryCode) add("Old recovery code rejected", !(await a.second(s.oldRecoveryCode)));
  else add("Old recovery code rejected", false, "not testable: no recovery code was captured");
  if (s.oldOwner.totp === owner.totp) add("Old Owner 2FA key rejected", false, "the 2FA key did not change");
  else add("Old Owner 2FA key rejected", !(await a.second(await freshTotp(s.oldOwner.totp, sleep))));
  const newOk = await a.second(await freshTotp(owner.totp, sleep));
  add("New Owner 2FA key accepted", newOk);

  // Recovery mechanism, end to end, with codes nobody keeps.
  if (newOk) {
    const codes = await generateRecoveryCodes(a, owner.totp, sleep);
    for (const v of codes) mask(v, out);
    await a.logout();
    const b = fresh(); b.jar = new Map(c.jar);
    const ok = codes.length > 0 && (await b.password(owner.email, owner.password)) && (await b.second(codes[0]));
    add("New recovery codes can be generated and used", ok);
    if (ok) await b.logout();
  } else add("New recovery codes can be generated and used", false, "not testable: new 2FA key not accepted");

  // Nothing left behind: no demo recovery codes (the verifier's own are deleted here), no pending demo invitations.
  await o.ops.query(`DELETE FROM mfa_recovery_codes WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@${DEMO_DOMAIN}')`);
  const n = async (sql: string) => Number((await o.ops.query<{ n: number }>(sql))[0]?.n ?? 0);
  add("No demo recovery codes remain", (await n(`SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@${DEMO_DOMAIN}')`)) === 0);
  add("No pending invitations from demo accounts", (await n(`SELECT COUNT(*) AS n FROM invitations WHERE accepted_at IS NULL AND expires_at > '${new Date().toISOString()}' AND invited_by IN (SELECT id FROM users WHERE email LIKE '%@${DEMO_DOMAIN}')`)) === 0);
  return checks;
}

/**
 * Before anything changes: when a rotation is pending, the Founder must be able to receive the new credentials (a usable
 * ACCESS_ARTIFACT_PASSPHRASE), and a STAGING_PREVIEW_PASSWORD override must not equal the live preview password (the
 * rotation would silently keep it). Compares keyed fingerprints only (scripts/staging-secrets.ts); prints no value.
 */
export async function gate(o: { ops: D1Ops; rootKey: string; epoch: string; rotate: boolean; passphrase?: string; fixedPreview?: string }): Promise<{ pending: boolean; problems: string[] }> {
  const pending = await rotationPending(o.ops, { epoch: o.epoch, rotate: o.rotate });
  if (!pending) return { pending, problems: [] };
  const problems: string[] = [];
  const p = passphraseProblem(o.passphrase);
  if (p) problems.push(`${p}: the rotated Owner credentials could not be delivered to the Founder`);
  if (o.fixedPreview) {
    const rows = await o.ops.query<{ fingerprint: string }>(`SELECT fingerprint FROM deploy_secret_fingerprints WHERE name = 'STAGING_ACCESS_PASSWORD'`).catch(() => []);
    if (rows[0]?.fingerprint === secretFingerprint(o.rootKey, "STAGING_ACCESS_PASSWORD", o.fixedPreview))
      problems.push("the STAGING_PREVIEW_PASSWORD secret equals the live preview password, so the rotation would not change it: set a new value or delete the secret");
  }
  return { pending, problems };
}

export const report = (checks: Check[]) => ["| Check | Result |", "|---|---|", ...checks.map((c) => `| ${c.name} | ${c.ok ? "PASS" : "**FAIL**"}${c.detail ? ` (${c.detail})` : ""} |`)].join("\n");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const mode = process.argv[2], url = arg("--url"), stateFile = arg("--state");
  try {
    if (mode === "gate") {
      const g = await gate({ ops: wranglerOps(), rootKey: process.env.ACCESS_ROOT_KEY ?? "", epoch: process.env.ACCESS_EPOCH ?? "1", rotate: process.env.ROTATE === "true", passphrase: process.env.ACCESS_ARTIFACT_PASSPHRASE, fixedPreview: process.env.FIXED_PREVIEW_PASSWORD || undefined });
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `pending=${g.pending}\n`);
      if (g.problems.length) {
        for (const p of g.problems) console.error(`::error title=Rotation blocked (nothing was changed)::${p}`);
        process.exit(1);
      }
      console.log(g.pending ? "Rotation pending: secure delivery is configured and the preview password will change." : "No rotation pending.");
      process.exit(0);
    }
    if (!url || !stateFile) throw new Error("--url and --state are required");
    if (mode === "capture") {
      const st = await capture({ base: url, ops: wranglerOps(), rootKey: process.env.ACCESS_ROOT_KEY ?? "", epoch: process.env.ACCESS_EPOCH ?? "1", rotate: process.env.ROTATE === "true", fixedPreview: process.env.FIXED_PREVIEW_PASSWORD || undefined });
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
    console.error(`::error::Rotation check failed: ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    process.exit(1);
  }
}
