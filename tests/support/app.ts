// Integration-test harness: real request pipeline (src/app/app.ts) + real migrations on in-memory SQLite.
import { createTestDb } from "./sqlite-d1.ts";
import type { SqliteDb } from "../../dev/sqlite-d1.ts";
import { handle } from "../../src/app/app.ts";
import type { Env } from "../../src/app/context.ts";
import { syncRequirements } from "../../src/readiness/ingest.ts";
import { hashPassword, newTotpSecret } from "../../src/lib/auth-crypto.ts";
import { newId, nowIso } from "../../src/lib/db.ts";
import type { Role } from "../../src/domain/authz.ts";
import type { StorageAdapter } from "../../src/adapters/storage.ts";

export const TEST_PASSWORD = "correct-horse-battery-staple";

export class MemoryStorage implements StorageAdapter {
  readonly kind = "local-disk" as const;
  objects = new Map<string, { data: Uint8Array; contentType: string }>();
  async put(key: string, data: Uint8Array, contentType: string) { this.objects.set(key, { data, contentType }); }
  async get(key: string) { const o = this.objects.get(key); return o ? { body: o.data, size: o.data.length, contentType: o.contentType } : null; }
  async delete(key: string) { this.objects.delete(key); }
}

export async function createTestApp(extra: Partial<Env> = {}) {
  const db = createTestDb();
  await syncRequirements(db);
  const storage = new MemoryStorage();
  const env: Env = { DB: db, ENVIRONMENT: "development", APP_URL: "http://crestmont.test", overrides: { storage }, ...extra };
  // close() releases the in-memory database. Tests that open an app per case can call it in a finally block; it is
  // safe to call more than once, so a test does not have to track whether it already did.
  let closed = false;
  const close = () => { if (!closed) { closed = true; (db as SqliteDb).raw.close(); } };
  return { db, env, storage, client: () => new TestClient(env), close };
}

export class TestClient {
  cookies = new Map<string, string>();
  private env: Env;
  constructor(env: Env) { this.env = env; }

  private absorb(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim(), value = decodeURIComponent(pair.slice(i + 1));
      if (attrs.some((a) => a.trim().toLowerCase() === "max-age=0")) this.cookies.delete(name); else this.cookies.set(name, value);
    }
  }
  private cookieHeader() { return [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; "); }

  async request(method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("cookie", this.cookieHeader());
    const res = await handle(new Request(new URL(path, "http://crestmont.test"), { method, headers, body: init.body }), this.env);
    this.absorb(res);
    return res;
  }

  async get(path: string) {
    return this.request("GET", path);
  }

  /** Ensures a CSRF cookie exists, then POSTs urlencoded (or multipart when a File/Blob is present). */
  async post(path: string, fields: Record<string, string | string[] | Blob | File> = {}, opts: { csrf?: string | false; origin?: string } = {}) {
    if (!this.cookies.has("cm_csrf")) await this.get("/login");
    const token = opts.csrf === false ? undefined : opts.csrf ?? this.cookies.get("cm_csrf");
    const hasFile = Object.values(fields).some((v) => typeof v !== "string" && !Array.isArray(v));
    let body: BodyInit;
    const headers: Record<string, string> = { origin: opts.origin ?? "http://crestmont.test" };
    if (hasFile) {
      const fd = new FormData();
      if (token) fd.set("_csrf", token);
      for (const [k, v] of Object.entries(fields)) {
        if (Array.isArray(v)) v.forEach((x) => fd.append(k, x)); else fd.append(k, v as string | Blob);
      }
      body = fd;
    } else {
      const sp = new URLSearchParams();
      if (token) sp.set("_csrf", token);
      for (const [k, v] of Object.entries(fields)) {
        if (Array.isArray(v)) v.forEach((x) => sp.append(k, x)); else sp.append(k, v as string);
      }
      body = sp.toString();
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    return this.request("POST", path, { body, headers });
  }

  /** Signs in with email + password. MFA was removed (Founder directive, 2026-11-06): the password is the whole
   *  sign-in for every account, so a redirect to /mfa is a regression and fails loudly. The third argument is accepted
   *  for older call sites that still pass a stored authenticator secret; it is never used. */
  async login(email: string, password = TEST_PASSWORD, _legacyTotpSecret?: string | null) {
    void _legacyTotpSecret;
    const res = await this.post("/login", { email, password });
    if (res.status !== 303) throw new Error(`login failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const location = res.headers.get("location") ?? "";
    if (location.startsWith("/mfa")) throw new Error(`login was sent to ${location}, but MFA was removed`);
    return this;
  }
}

/** Stores an authenticator secret on an existing user, as an account enrolled before MFA was removed would have.
 *  The secret is kept as account data and is never asked for at sign-in. */
export async function enrolTotp(db: Env["DB"], userId: string): Promise<string> {
  const secret = newTotpSecret();
  await db.prepare(`UPDATE users SET totp_secret = ?, mfa_enabled = 1, totp_pending_secret = NULL WHERE id = ?`).bind(secret, userId).run();
  return secret;
}

/** Creates an internal staff user. The row carries a stored TOTP secret (as accounts enrolled before MFA was removed
 *  do) so every test also proves a stored secret is ignored at sign-in. Returns credentials for TestClient.login. */
export async function createStaff(db: Env["DB"], role: Role, email = `${role}@crestmont.test`, name = `Test ${role}`) {
  let org = await db.prepare(`SELECT id FROM organizations WHERE kind = 'internal' LIMIT 1`).first<{ id: string }>();
  if (!org) {
    org = { id: "org_crestmont" };
    await db.prepare(`INSERT INTO organizations (id, name, kind, created_at) VALUES ('org_crestmont','Crestmont Website Development','internal',?)`).bind(nowIso()).run();
  }
  const id = newId("usr");
  const secret = newTotpSecret();
  await db.prepare(`INSERT INTO users (id, email, display_name, password_hash, email_verified_at, totp_secret, mfa_enabled, created_at) VALUES (?,?,?,?,?,?,1,?)`)
    .bind(id, email, name, await hashPassword(TEST_PASSWORD), nowIso(), secret, nowIso()).run();
  await db.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (?,?,?,?,?)`).bind(newId("mbr"), id, org.id, role, nowIso()).run();
  return { id, email, secret, organizationId: org.id };
}

/**
 * Creates a customer administrator (and their organization). By default the row carries a stored TOTP secret (as an
 * account enrolled before MFA was removed would); it is never asked for. `{ mfa: false }` creates an administrator
 * with no authenticator at all; `secret` is then null.
 */
export async function createCustomer(db: Env["DB"], email = `client${Math.floor(Math.random() * 1e9)}@example.com`, orgName = "Acme Plumbing", opts: { mfa?: boolean } = {}) {
  const id = newId("usr"), orgId = newId("org");
  const secret = opts.mfa === false ? null : newTotpSecret();
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, display_name, password_hash, email_verified_at, totp_secret, mfa_enabled, created_at) VALUES (?,?,?,?,?,?,?,?)`).bind(id, email, "Pat Customer", await hashPassword(TEST_PASSWORD), nowIso(), secret, secret ? 1 : 0, nowIso()),
    db.prepare(`INSERT INTO organizations (id, name, kind, created_at) VALUES (?,?,'customer',?)`).bind(orgId, orgName, nowIso()),
    db.prepare(`INSERT INTO memberships (id, user_id, organization_id, role_id, created_at) VALUES (?,?,?,'customer_admin',?)`).bind(newId("mbr"), id, orgId, nowIso()),
  ]);
  return { id, email, organizationId: orgId, secret };
}

/** Latest email captured by the development outbox for an address. */
export async function lastEmail(db: Env["DB"], to: string) {
  return db.prepare(`SELECT d.template, m.subject, m.text_body FROM email_deliveries d JOIN email_messages m ON m.delivery_id = d.id WHERE d.to_email = ? ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1`).bind(to)
    .first<{ template: string; subject: string; text_body: string }>();
}

export const linkFrom = (text: string, path: string) => {
  const m = new RegExp(`http://crestmont\\.test(${path.replace(/[/?]/g, (c) => "\\" + c)}[^\\s]*)`).exec(text);
  if (!m) throw new Error(`No ${path} link in: ${text}`);
  return m[1];
};
