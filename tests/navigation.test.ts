import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createStaff, createCustomer } from "./support/app.ts";
import { staffNav, portalNav } from "../src/routes/nav.ts";
import { can } from "../src/domain/authz.ts";

const OWNER_MODULES = ["Executive overview", "Launch readiness", "Engineering", "Development", "Staging", "Production", "CRM", "Sales", "Quotes",
  "Customers", "Projects", "Tasks", "Employees", "Support", "Refunds", "Disputes", "Revenue", "Subscriptions", "Invoices", "Profitability",
  "AI operations", "AI receptionist", "Email operations", "Portfolio", "Website CMS", "Integrations", "Monitoring", "Security", "Audit logs",
  "Backups", "Reports", "Business settings"];

test("[OWN-001] the Owner navigation exposes all 32 §34 modules and every one renders (200)", async () => {
  const { db, client } = await createTestApp();
  const o = await createStaff(db, "owner");
  const c = await client().login(o.email, undefined, o.secret);
  const items = staffNav({} as never).flatMap((g) => g.items);
  for (const m of OWNER_MODULES) assert.ok(items.some((i) => i.label === m), `module ${m} in navigation`);
  for (const i of items) {
    const res = await c.get(i.href);
    assert.equal(res.status, 200, `${i.label} (${i.href}) → ${res.status}`);
    const body = await res.text();
    const visible = body.replace(/placeholder="[^"]*"/g, "");
    assert.doesNotMatch(visible, /coming soon|lorem ipsum|\bplaceholder\b/i, `${i.href} has no placeholder copy`);
    assert.doesNotMatch(visible, /\bTODO\b|FIXME/, `${i.href} has no unfinished-work markers`);
  }
});

test("[OWN-001] staff only see and reach modules their role permits", async () => {
  const { db, client } = await createTestApp();
  const dev = await createStaff(db, "developer");
  const c = await client().login(dev.email, undefined, dev.secret);
  const actor = { kind: "user" as const, userId: dev.id, roles: [{ role: "developer" as const, organizationId: dev.organizationId }], mfaVerified: true };
  const home = await (await c.get("/staff")).text();
  for (const i of staffNav({} as never).flatMap((g) => g.items)) {
    const allowed = !i.perm || can(actor, i.perm);
    assert.equal(home.includes(`href="${i.href}"`), allowed, `${i.href} visibility for developer`);
    if (!allowed) assert.equal((await c.get(i.href)).status, 403, `${i.href} refused server-side for developer`);
  }
});

test("[PORTAL-009] customer portal navigation includes support and every portal module renders", async () => {
  const { db, client } = await createTestApp();
  const cust = await createCustomer(db, "nav@example.com");
  const c = await client().login(cust.email);
  for (const i of portalNav({} as never).flatMap((g) => g.items)) {
    assert.equal((await c.get(i.href)).status, 200, `${i.href}`);
  }
  assert.ok(portalNav({} as never).flatMap((g) => g.items).some((i) => i.href === "/portal/support"));
});
