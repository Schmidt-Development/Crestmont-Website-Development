// Staging credential rotation: exposure audit and proof that old credentials stop working
// (security remediation 2026-10-28, findings F-18/F-19). Used by .github/workflows/deploy-staging.yml.
//
//   audit  Before rotation. Summarises how the demo accounts were used: sign-ins (by user agent: deploy
//          automation vs. anything else), accounts/invitations created by demo users, privileged actions,
//          data exports, failed sign-ins. Public step summary gets COUNTS only; the details (IPs, user agents,
//          emails) go to a private file that leaves the runner only inside the sealed access notes.
//   pre    Before rotation, when one is due and credentials are live: derives the CURRENT (old) credentials from
//          the stored salt and the root key, and signs in as the Owner to hold an old session. Writes a private
//          state file (mode 600); every value is masked in the log.
//   post   After rotation and after the new credentials were verified: the old preview password(s), old Owner
//          password, old 2FA key, old preview cookie and old Owner session must all be rejected; recovery codes,
//          pending enrolments and pre-rotation sessions of demo users must be gone.
// Prints no credential. Exit 1 when a post check fails.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { totpCode } from "../src/lib/auth-crypto.ts";
import { DEMO_DOMAIN, derivePassword, deriveTotp, previewFingerprint, wranglerOps, type D1Ops } from "./staging-access.ts";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const UA = "crestmont-staging-rotation-check";
const AUTOMATION_UA = /^(crestmont-staging-verifier|crestmont-post-deploy-check|crestmont-staging-quality|crestmont-staging-rotation-check)$|HeadlessChrome|Playwright/;
const demo = `(SELECT id FROM users WHERE email LIKE '%@${DEMO_DOMAIN}')`;

/** Minimal cookie-keeping HTTP client (same behaviour as scripts/verify-staging-access.ts). */
export function client(base: string, f: Fetch = fetch, jar = new Map<string, string>()) {
  const b = base.replace(/\/$/, "");
  const send = async (method: string, path: string, form?: Record<string, string>) => {
    const headers: Record<string, string> = { "user-agent": UA };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
    let body: string | undefined;
    if (form) { body = new URLSearchParams(form).toString(); headers["content-type"] = "application/x-www-form-urlencoded"; headers.origin = new URL(b).origin; }
    const res = await f(b + path, { method, headers, body, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      if (attrs.some((a) => a.trim().toLowerCase() === "max-age=0")) jar.delete(name); else jar.set(name, decodeURIComponent(pair.slice(i + 1).trim()));
    }
    await res.arrayBuffer().catch(() => undefined);
    return res;
  };
  const loc = (r: Response) => new URL(r.headers.get("location") ?? "/", b).pathname;
  const gate = async (password: string) => { const r = await send("POST", "/__preview-access", { password, next: "/login" }); return r.status === 303 && jar.has("cm_preview"); };
  const signIn = async (email: string, password: string) => {
    await send("GET", "/login");
    const r = await send("POST", "/login", { _csrf: jar.get("cm_csrf") ?? "", email, password });
    return r.status === 303 && loc(r).startsWith("/mfa");
  };
  const mfa = async (secret: string) => {
    if (30 - (Math.floor(Date.now() / 1000) % 30) < 5) await new Promise((res) => setTimeout(res, 6_000));
    const r = await send("POST", "/mfa", { _csrf: jar.get("cm_csrf") ?? "", code: await totpCode(secret) });
    return r.status === 303 && loc(r).startsWith("/staff");
  };
  return { jar, send, loc, gate, signIn, mfa };
}

// ── audit ──
export interface AuditResult { publicLines: string[]; privateText: string; unknownSignIns: number }
export async function audit(ops: D1Ops): Promise<AuditResult> {
  const rows = <T,>(sql: string) => ops.query<T>(sql);
  const sessions = await rows<{ email: string; ip: string | null; ua: string | null; created_at: string }>(
    `SELECT u.email, s.ip, s.user_agent AS ua, s.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.user_id IN ${demo} ORDER BY s.created_at`);
  const unknown = sessions.filter((s) => !AUTOMATION_UA.test(s.ua ?? ""));
  const signIns = await rows<{ day: string; n: number; ips: number }>(
    `SELECT substr(created_at,1,10) AS day, COUNT(*) AS n, COUNT(DISTINCT ip) AS ips FROM audit_logs WHERE action = 'session.created' AND actor_user_id IN ${demo} GROUP BY day ORDER BY day`);
  const newUsers = await rows<{ email: string; created_at: string }>(
    `SELECT email, created_at FROM users WHERE email NOT LIKE '%@${DEMO_DOMAIN}' AND id <> 'usr_system' AND email NOT LIKE '%@deleted.invalid' ORDER BY created_at`);
  const invites = await rows<{ email: string; role_id: string; accepted_at: string | null; created: string | null }>(
    `SELECT i.email, i.role_id, i.accepted_at, (SELECT MIN(created_at) FROM audit_logs a WHERE a.action = 'invitation.created' AND a.actor_user_id = i.invited_by) AS created FROM invitations i WHERE i.invited_by IN ${demo}`);
  const privileged = await rows<{ action: string; n: number }>(
    `SELECT action, COUNT(*) AS n FROM audit_logs WHERE actor_user_id IN ${demo} AND (action LIKE 'employee.%' OR action LIKE 'invitation.%' OR action LIKE 'user.%' OR action LIKE '%.exported' OR action LIKE 'privacy.%'
       OR action LIKE 'integration%' OR action LIKE 'settings.%' OR action LIKE 'security.%' OR action LIKE 'refund.%' OR action LIKE 'pricing.%' OR action LIKE 'mfa.%' OR action LIKE 'session.step_up%' OR action LIKE 'share_link.created')
     GROUP BY action ORDER BY n DESC`);
  const failed = await rows<{ day: string; n: number }>(
    `SELECT substr(created_at,1,10) AS day, COUNT(*) AS n FROM security_events WHERE kind IN ('login_failed','login_locked','login_blocked_locked','mfa_failed') AND (email LIKE '%@${DEMO_DOMAIN}' OR user_id IN ${demo}) GROUP BY day ORDER BY day`);

  const publicLines = [
    `Demo-account sessions on record: ${sessions.length} (deploy automation ${sessions.length - unknown.length}; **other clients ${unknown.length}**)`,
    `Demo-account sign-ins by day: ${signIns.map((d) => `${d.day} ${d.n} from ${d.ips} IP(s)`).join("; ") || "none"}`,
    `Accounts outside the demo domain: ${newUsers.length}`,
    `Invitations sent by demo accounts: ${invites.length} (accepted ${invites.filter((i) => i.accepted_at).length})`,
    `Privileged/sensitive actions by demo accounts: ${privileged.map((p) => `${p.action} ×${p.n}`).join(", ") || "none"}`,
    `Failed demo sign-ins/2FA by day: ${failed.map((d) => `${d.day} ${d.n}`).join("; ") || "none"}`,
  ];
  const privateText = [
    "# Staging exposure audit (private — sealed with the access notes)", "",
    "Sessions of demo accounts from clients other than the deploy automation (review each: was it you?):", "",
    "| Account | Created | IP | User agent |", "|---|---|---|---|",
    ...unknown.map((s) => `| ${s.email} | ${s.created_at} | ${s.ip ?? "—"} | ${(s.ua ?? "—").replace(/\|/g, "/").slice(0, 160)} |`), "",
    "Accounts outside the demo domain:", "", ...newUsers.map((u) => `- ${u.email} (created ${u.created_at})`), "",
    "Invitations sent by demo accounts:", "", ...invites.map((i) => `- ${i.email} as ${i.role_id}${i.accepted_at ? `, ACCEPTED ${i.accepted_at}` : ", not accepted (expired by the rotation)"}`), "",
    ...publicLines.map((l) => `- ${l}`),
  ].join("\n");
  return { publicLines, privateText, unknownSignIns: unknown.length };
}

// ── pre ──
export interface PreState { due: boolean; reason: string; previewCandidates: string[]; livePreview: string | null; owner: { email: string; password: string; totp: string | null } | null; ownerSignedIn: boolean; cookies: Record<string, string> }
export async function pre(ops: D1Ops, o: { base: string; rootKey: string; epoch: string; rotate: boolean; fixedPreviewPassword?: string }, f: Fetch = fetch): Promise<PreState> {
  const meta = Object.fromEntries((await ops.query<{ key: string; value: string }>(`SELECT key, value FROM _staging_access`).catch(() => [] as { key: string; value: string }[])).map((r) => [r.key, r.value]));
  const due = o.rotate || !meta.salt || meta.epoch !== o.epoch;
  const empty: PreState = { due, reason: "", previewCandidates: [], livePreview: null, owner: null, ownerSignedIn: false, cookies: {} };
  if (!due) return { ...empty, reason: "no rotation due" };
  if (!meta.salt) return { ...empty, reason: "first issue (no live credentials)" };
  const ownerRow = (await ops.query<{ email: string; mfa_enabled: number }>(
    `SELECT u.email, u.mfa_enabled FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.role_id = 'owner' AND u.email LIKE '%@${DEMO_DOMAIN}' ORDER BY u.email LIMIT 1`))[0];
  const derivedPreview = await derivePassword(o.rootKey, meta.salt, "preview");
  const retired = new Set(Object.keys(meta).filter((k) => k.startsWith("retired_preview:")).map((k) => k.slice(16)));
  const candidates: string[] = [];
  if (o.fixedPreviewPassword && !retired.has(await previewFingerprint(o.rootKey, o.fixedPreviewPassword))) candidates.push(o.fixedPreviewPassword);
  candidates.push(derivedPreview);
  const owner = ownerRow ? { email: ownerRow.email, password: await derivePassword(o.rootKey, meta.salt, `password:${ownerRow.email}`), totp: ownerRow.mfa_enabled ? await deriveTotp(o.rootKey, meta.salt, ownerRow.email) : null } : null;
  const c = client(o.base, f);
  let livePreview: string | null = null;
  for (const p of candidates) if (await c.gate(p)) { livePreview = p; break; }
  let ownerSignedIn = false;
  if (livePreview && owner && owner.totp && await c.signIn(owner.email, owner.password) && await c.mfa(owner.totp)) ownerSignedIn = (await c.send("GET", "/staff")).status === 200;
  return { due, reason: "rotation due", previewCandidates: [...new Set([...(o.fixedPreviewPassword ? [o.fixedPreviewPassword] : []), derivedPreview])], livePreview, owner, ownerSignedIn, cookies: Object.fromEntries(c.jar) };
}

// ── post ──
export interface Check { name: string; ok: boolean; detail?: string }
export async function post(ops: D1Ops, state: PreState, now: { base: string; previewPassword: string; owner: { email: string; password: string; totp: string } }, f: Fetch = fetch): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  // 1. Old preview passwords no longer open the gate (each distinct from the new one).
  for (const [i, p] of state.previewCandidates.entries()) {
    if (p === now.previewPassword) { add(`old preview password #${i + 1} rejected`, false, "still the live password"); continue; }
    add(`old preview password #${i + 1} rejected`, !(await client(now.base, f).gate(p)));
  }
  // 2. The old preview cookie alone no longer passes the gate.
  if (state.cookies.cm_preview) {
    const c = client(now.base, f, new Map([["cm_preview", state.cookies.cm_preview]]));
    add("old preview cookie rejected", (await c.send("GET", "/")).status === 401);
  }
  // 3. The old Owner session (presented with a NEW gate cookie) is signed out.
  if (state.cookies.cm_session) {
    const c = client(now.base, f);
    if (!(await c.gate(now.previewPassword))) add("old Owner session rejected", false, "new preview password not accepted");
    else {
      c.jar.set("cm_session", state.cookies.cm_session);
      const r = await c.send("GET", "/staff");
      add("old Owner session rejected", r.status === 303 && c.loc(r).startsWith("/login"), `HTTP ${r.status} → ${r.status === 303 ? c.loc(r) : "page"}`);
    }
  } else add("old Owner session rejected", true, state.due ? "no old session could be established before rotation (see pre)" : "no rotation");
  // 4. Old Owner password rejected; new password + old 2FA key rejected; new password + new key accepted.
  if (state.owner) {
    const c = client(now.base, f);
    await c.gate(now.previewPassword);
    if (state.owner.password !== now.owner.password) add("old Owner password rejected", !(await c.signIn(state.owner.email, state.owner.password)));
    else add("old Owner password rejected", false, "password unchanged");
    if (state.owner.totp) {
      const c2 = client(now.base, f);
      await c2.gate(now.previewPassword);
      const pw = await c2.signIn(now.owner.email, now.owner.password);
      if (!pw) add("old 2FA key rejected", false, "new password not accepted");
      else if (await totpCode(state.owner.totp) === await totpCode(now.owner.totp)) add("old 2FA key rejected", true, "codes coincide this step; key differs");
      else add("old 2FA key rejected", !(await c2.mfa(state.owner.totp)));
      const c3 = client(now.base, f);
      await c3.gate(now.previewPassword);
      add("new Owner password + new 2FA key accepted", (await c3.signIn(now.owner.email, now.owner.password)) && (await c3.mfa(now.owner.totp)));
      await c3.send("POST", "/logout", { _csrf: c3.jar.get("cm_csrf") ?? "" });
    }
  }
  // 5. Database state of demo accounts.
  const q1 = async (sql: string) => Number((await ops.query<{ n: number }>(sql))[0]?.n ?? -1);
  add("recovery codes of demo accounts removed", (await q1(`SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id IN ${demo}`)) === 0);
  add("pending 2FA enrolments of demo accounts cleared", (await q1(`SELECT COUNT(*) AS n FROM users WHERE email LIKE '%@${DEMO_DOMAIN}' AND totp_pending_secret IS NOT NULL`)) === 0);
  add("no demo-account session older than the rotation", (await q1(`SELECT COUNT(*) AS n FROM sessions WHERE user_id IN ${demo} AND revoked_at IS NULL AND created_at < (SELECT value FROM _staging_access WHERE key = 'rotated_at')`)) === 0);
  add("no open invitation from a demo account", (await q1(`SELECT COUNT(*) AS n FROM invitations WHERE accepted_at IS NULL AND invited_by IN ${demo} AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`)) === 0);
  return checks;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd] = process.argv.slice(2);
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const summary = (s: string) => { if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, s + "\n"); };
  const mask = (v: string | null | undefined) => { if (v) console.log(`::add-mask::${v}`); };
  const ops = wranglerOps();
  try {
    if (cmd === "audit") {
      const r = await audit(ops);
      writeFileSync(arg("--private") ?? "access/exposure-audit.md", r.privateText + "\n", { mode: 0o600 });
      summary(["### Staging exposure audit (counts only; details are in the sealed access notes)", ...r.publicLines.map((l) => `- ${l}`)].join("\n"));
      for (const l of r.publicLines) console.log(l);
      if (r.unknownSignIns) console.log(`::warning title=Review demo-account sign-ins::${r.unknownSignIns} demo-account session(s) came from clients other than the deploy automation. Details are in the sealed access notes (exposure-audit section).`);
    } else if (cmd === "pre") {
      const s = await pre(ops, { base: arg("--url")!, rootKey: process.env.ACCESS_ROOT_KEY ?? "", epoch: process.env.ACCESS_EPOCH ?? "1", rotate: process.env.ROTATE === "true", fixedPreviewPassword: process.env.FIXED_PREVIEW_PASSWORD || undefined });
      for (const v of [...s.previewCandidates, s.owner?.password, s.owner?.totp, ...Object.values(s.cookies)]) mask(v);
      writeFileSync(arg("--state")!, JSON.stringify(s), { mode: 0o600 });
      console.log(`Rotation pre-check: ${s.reason}${s.due && s.previewCandidates.length ? `; live preview password ${s.livePreview ? "identified" : "NOT identified"}; old Owner session ${s.ownerSignedIn ? "held" : "NOT established"}` : ""}.`);
      if (s.due && s.previewCandidates.length && !s.ownerSignedIn) console.log("::warning title=Old Owner credentials did not sign in before rotation::The current (old) Owner credentials derived from the stored salt did not reach the Owner command center. If nobody changed them deliberately, treat this as a possible unauthorized change and review the exposure audit.");
    } else if (cmd === "post") {
      const acc = JSON.parse(readFileSync(arg("--access")!, "utf8")) as { rotated: boolean; previewPassword: string; accounts: { role: string; email: string; password: string; totp: string | null }[] };
      if (!acc.rotated) { console.log("Rotation post-check skipped: no rotation in this run."); process.exit(0); }
      let s: PreState;
      try { s = JSON.parse(readFileSync(arg("--state")!, "utf8")) as PreState; } catch { throw new Error("credentials were rotated but the pre-rotation state is missing, so the rotation cannot be verified"); }
      if (!s.previewCandidates.length) { console.log(`Rotation post-check skipped: ${s.reason}.`); process.exit(0); }
      const o = acc.accounts.find((a) => a.role === "owner")!;
      const checks = await post(ops, s, { base: arg("--url")!, previewPassword: acc.previewPassword, owner: { email: o.email, password: o.password, totp: o.totp! } });
      summary(["### Credential rotation verification", "| Check | Result |", "|---|---|", ...checks.map((c) => `| ${c.name} | ${c.ok ? "PASS" : "**FAIL**"}${c.detail ? ` (${c.detail})` : ""} |`)].join("\n"));
      for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
      if (checks.some((c) => !c.ok)) { console.log("::error::Credential rotation verification failed (see the step summary)."); process.exit(1); }
    } else throw new Error("usage: staging-rotation-check.ts audit|pre|post");
  } catch (e) {
    console.error(`::error::staging-rotation-check ${cmd}: ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    process.exit(1);
  }
}
