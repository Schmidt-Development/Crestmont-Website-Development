// Historical CRM duplicate audit — READ-ONLY dry run (CRM duplicate protection, Phase 8).
//
// Opens a SQLite copy of the CRM database read-only, groups contacts that share a normalized phone (E.164), a
// normalized email (trim + lowercase), a website domain + location, or a name at the same company, and classifies each
// group. It never writes to the database it reads. Runbook: docs/crm-identity/RUNBOOK.md §4.
//
//   npx wrangler@4.149.0 d1 export crestmont-production --remote --env production --output crm.sql   (D1 → SQL file)
//   sqlite3 crm.sqlite < crm.sql                                                                (SQL file → SQLite)
//   node --no-warnings scripts/crm-duplicate-audit.ts --db crm.sqlite --out report.json --md report.md
//   node --no-warnings scripts/crm-duplicate-audit.ts --db crm.sqlite --emit-review-sql review-items.sql
//
// Output contains record ids and counts only. --show-values adds names/emails/phones for the Founder's local review;
// never commit or share such a report (the repository is public).
//
// Classes (one per group, most cautious wins):
//   existing_customer_conflict  the group touches a customer (organization, portal account or paid lead)
//   shared_contact_identity     linked only by a phone/email that different businesses use
//   conflicting_records         same identifier and business, but names/websites disagree
//   safe_exact_duplicate        same email (or same phone and business), same name, nothing conflicting, no customer
//   probable_duplicate          same business identity (domain + location, or name at company) without a shared identifier
// No class is merged automatically. --emit-review-sql writes INSERT OR IGNORE statements that put every group in the
// founder review queue (kind historical_duplicate); applying that file is a separate, deliberate step.
import { DatabaseSync } from "node:sqlite";
import { writeFileSync, existsSync } from "node:fs";
import { phoneKey, emailKey, domainKey, companyKey } from "../src/services/contact-identity.ts";

type Klass = "existing_customer_conflict" | "shared_contact_identity" | "conflicting_records" | "safe_exact_duplicate" | "probable_duplicate";
export interface AuditContact {
  id: string; name: string; email: string | null; phone: string | null; company_id: string | null; company_name: string | null; website: string | null;
  location: string | null; organization_id: string | null; member_org: string | null; lead_ids: string; open_leads: number; converted: number; merged_only: number;
}
export interface AuditGroup { id: number; klass: Klass; contacts: string[]; leads: string[]; keys: string[]; reasons: string[]; customerOrgs: string[] }
export interface AuditReport {
  generatedAt: string; readOnly: true; contacts: number; groups: number; byClass: Record<Klass, number>;
  invalidIdentifiers: { phones: number; emails: number }; groupsDetail: AuditGroup[];
}

const has = (db: DatabaseSync, table: string, col?: string) => {
  const t = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(table);
  if (!t || !col) return !!t;
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).some((c) => c.name === col);
};

export function auditDatabase(db: DatabaseSync): AuditReport {
  const loc = has(db, "companies", "location_norm") ? "co.location_norm" : "NULL";
  const merged = has(db, "leads", "merged_into_lead_id") ? "l.merged_into_lead_id IS NULL" : "1=1";
  const rows = db.prepare(`SELECT c.id, c.name, c.email, c.phone, c.company_id, co.name AS company_name, co.website, ${loc} AS location, co.organization_id,
      (SELECT m.organization_id FROM memberships m WHERE m.user_id = c.user_id AND m.role_id LIKE 'customer_%' LIMIT 1) AS member_org,
      COALESCE((SELECT group_concat(l.id) FROM leads l WHERE l.contact_id = c.id AND ${merged}), '') AS lead_ids,
      (SELECT COUNT(*) FROM leads l WHERE l.contact_id = c.id AND ${merged} AND l.stage NOT IN ('converted','lost','rejected','archived')) AS open_leads,
      (SELECT COUNT(*) FROM leads l WHERE l.contact_id = c.id AND l.stage = 'converted') AS converted,
      (EXISTS (SELECT 1 FROM leads l WHERE l.contact_id = c.id) AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.contact_id = c.id AND ${merged})) AS merged_only
    FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE c.name <> 'Deleted contact'`).all() as unknown as AuditContact[];
  const live = rows.filter((r) => !r.merged_only);
  const byId = new Map(live.map((r) => [r.id, r]));
  const keyMap = new Map<string, string[]>();
  const add = (k: string, id: string) => { const g = keyMap.get(k); if (g) g.push(id); else keyMap.set(k, [id]); };
  let badPhones = 0, badEmails = 0;
  for (const r of live) {
    const p = phoneKey(r.phone), e = emailKey(r.email), d = domainKey(r.website), co = companyKey(r.company_name);
    if (r.phone && !p) badPhones++;
    if (r.email && !e) badEmails++;
    if (p) add(`phone:${p}`, r.id);
    if (e) add(`email:${e}`, r.id);
    if (d) add(`domain:${d}|${r.location ?? ""}`, r.id);
    if (co && r.name.trim()) add(`namecompany:${r.name.trim().toLowerCase().replace(/\s+/g, " ")}|${co}`, r.id);
  }
  // Union-find over keys. A phone/email used by several different businesses is a SHARED identifier: it is reported as
  // its own group and never joins those businesses together (same rule as the intake engine).
  const parent = new Map<string, string>(live.map((r) => [r.id, r.id]));
  const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
  const union = (ids: string[]) => { for (const id of ids.slice(1)) parent.set(find(id), find(ids[0])); };
  const business = (c: AuditContact) => domainKey(c.website) ?? companyKey(c.company_name);
  const edgeKinds = new Map<string, Set<string>>();
  const noteKind = (ids: string[], kind: string) => { for (const id of ids) edgeKinds.set(id, new Set([...(edgeKinds.get(id) ?? []), kind])); };
  const sharedGroups: { key: string; ids: string[] }[] = [];
  for (const [k, ids] of keyMap) {
    if (ids.length < 2) continue;
    const kind = k.split(":")[0];
    if (kind === "phone" || kind === "email") {
      const known = new Map<string, string[]>(), unknown: string[] = [];
      for (const id of ids) { const b = business(byId.get(id)!); if (b) known.set(b, [...(known.get(b) ?? []), id]); else unknown.push(id); }
      if (known.size > 1) {
        sharedGroups.push({ key: kind, ids });
        for (const bucket of known.values()) if (bucket.length > 1) { union(bucket); noteKind(bucket, kind); }
        continue;
      }
      const all = [...(known.values().next().value ?? []), ...unknown];
      union(all); noteKind(all, kind);
    } else { union(ids); noteKind(ids, kind); }
  }
  const members = new Map<string, string[]>();
  for (const r of live) { const root = find(r.id); members.set(root, [...(members.get(root) ?? []), r.id]); }
  const groups: AuditGroup[] = [];
  let gid = 0;
  const customerOf = (cs: AuditContact[]) => [...new Set(cs.flatMap((c) => [c.organization_id, c.member_org].filter(Boolean) as string[]))];
  const leadsOf = (cs: AuditContact[]) => cs.flatMap((c) => c.lead_ids ? c.lead_ids.split(",") : []).sort();
  for (const ids of members.values()) {
    if (ids.length < 2) continue;
    const cs = ids.map((i) => byId.get(i)!);
    const kinds = new Set(ids.flatMap((i) => [...(edgeKinds.get(i) ?? [])]));
    const customerOrgs = customerOf(cs);
    const customer = customerOrgs.length > 0 || cs.some((c) => c.converted > 0);
    const names = new Set(cs.map((c) => c.name.trim().toLowerCase().replace(/\s+/g, " ")));
    const websites = new Set(cs.map((c) => domainKey(c.website)).filter(Boolean));
    const sharedId = kinds.has("phone") || kinds.has("email");
    const reasons: string[] = [];
    let klass: Klass;
    if (customer) { klass = "existing_customer_conflict"; reasons.push(customerOrgs.length > 1 ? `${customerOrgs.length} customer organizations` : "includes a customer"); }
    else if (sharedId && (names.size > 1 || websites.size > 1)) { klass = "conflicting_records"; reasons.push(names.size > 1 ? "names differ" : "websites differ"); }
    else if (sharedId) { klass = "safe_exact_duplicate"; reasons.push("same identifier, same name, no conflicting values"); }
    else { klass = "probable_duplicate"; reasons.push("same business identity without a shared phone or email"); }
    groups.push({ id: ++gid, klass, contacts: ids.sort(), leads: leadsOf(cs), keys: [...kinds].sort(), reasons, customerOrgs });
  }
  for (const sg of sharedGroups) {
    const cs = sg.ids.map((i) => byId.get(i)!);
    const customerOrgs = customerOf(cs);
    const nBiz = new Set(cs.map(business).filter(Boolean)).size;
    groups.push({ id: ++gid, klass: customerOrgs.length > 1 ? "existing_customer_conflict" : "shared_contact_identity", contacts: [...sg.ids].sort(), leads: leadsOf(cs), keys: [sg.key],
      reasons: [`${nBiz} different businesses share this ${sg.key}${customerOrgs.length ? ` (customer orgs: ${customerOrgs.length})` : ""}; keep separate unless they are one business`], customerOrgs });
  }
  const byClass = { existing_customer_conflict: 0, shared_contact_identity: 0, conflicting_records: 0, safe_exact_duplicate: 0, probable_duplicate: 0 } as Record<Klass, number>;
  for (const g of groups) byClass[g.klass]++;
  return { generatedAt: new Date().toISOString(), readOnly: true, contacts: live.length, groups: groups.length, byClass, invalidIdentifiers: { phones: badPhones, emails: badEmails }, groupsDetail: groups };
}

const LABEL: Record<Klass, string> = { existing_customer_conflict: "Existing customer conflict", shared_contact_identity: "Shared contact identity", conflicting_records: "Conflicting records", safe_exact_duplicate: "Safe exact duplicate", probable_duplicate: "Probable duplicate" };

export function reviewSql(report: AuditReport): string {
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const lines = ["-- Historical duplicate review items (generated by scripts/crm-duplicate-audit.ts). Adds review items only; merges nothing.",
    "-- Apply deliberately: npx wrangler@4.149.0 d1 execute crestmont-<env> --remote --env <env> --file <this file>"];
  for (const g of report.groupsDetail) {
    const reason = `${LABEL[g.klass]}: ${g.contacts.length} contacts sharing ${g.keys.join(", ")} (${g.reasons.join("; ")}). Contacts ${g.contacts.join(", ")}; leads ${g.leads.join(", ") || "none"}. Review and merge from the lead page if they are the same; never merge customers without the Owner.`;
    lines.push(`INSERT INTO crm_identity_reviews (id, kind, contact_id, lead_id, reason, dedupe_key, created_at) SELECT 'rev_' || lower(hex(randomblob(12))), 'historical_duplicate', ${lit(g.contacts[0])}, ${g.leads[0] ? lit(g.leads[0]) : "NULL"}, ${lit(reason.slice(0, 500))}, ${lit(`hist:${g.contacts.join(":").slice(0, 400)}`)}, strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM crm_identity_reviews WHERE dedupe_key = ${lit(`hist:${g.contacts.join(":").slice(0, 400)}`)});`);
  }
  return lines.join("\n") + "\n";
}

export function markdown(report: AuditReport, values?: Map<string, AuditContact>): string {
  const out = [`# CRM duplicate audit (dry run)`, ``, `Generated ${report.generatedAt}. Read-only: nothing was changed.`, ``,
    `- Contacts examined: ${report.contacts}`, `- Duplicate groups: ${report.groups}`, `- Unusable identifiers: ${report.invalidIdentifiers.phones} phone(s), ${report.invalidIdentifiers.emails} email(s)`, ``,
    `| Class | Groups | Action |`, `|---|---|---|`,
    `| ${LABEL.safe_exact_duplicate} | ${report.byClass.safe_exact_duplicate} | Review, then merge with the existing lead merge (history kept) |`,
    `| ${LABEL.probable_duplicate} | ${report.byClass.probable_duplicate} | Review; merge only if confirmed |`,
    `| ${LABEL.conflicting_records} | ${report.byClass.conflicting_records} | Review field by field; keep verified/customer values |`,
    `| ${LABEL.shared_contact_identity} | ${report.byClass.shared_contact_identity} | Usually keep separate (shared line/inbox); mark "not a duplicate" |`,
    `| ${LABEL.existing_customer_conflict} | ${report.byClass.existing_customer_conflict} | Owner review only; never merged automatically |`, ``];
  for (const g of report.groupsDetail) {
    out.push(`## Group ${g.id} — ${LABEL[g.klass]}`, ``, `Shared: ${g.keys.join(", ")} · ${g.reasons.join("; ")}${g.customerOrgs.length ? ` · customer orgs: ${g.customerOrgs.join(", ")}` : ""}`, ``);
    for (const id of g.contacts) { const v = values?.get(id); out.push(`- ${id}${v ? ` — ${v.name} · ${v.email ?? "—"} · ${v.phone ?? "—"} · ${v.company_name ?? "—"}` : ""}`); }
    out.push(`- Leads: ${g.leads.join(", ") || "none"}`, ``);
  }
  return out.join("\n");
}

if (import.meta.main) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const path = arg("--db");
  if (!path || !existsSync(path)) { console.error("Usage: node --no-warnings scripts/crm-duplicate-audit.ts --db <sqlite file> [--out report.json] [--md report.md] [--emit-review-sql file.sql] [--show-values]"); process.exit(2); }
  const db = new DatabaseSync(path, { readOnly: true });
  const report = auditDatabase(db);
  const values = process.argv.includes("--show-values") ? new Map((db.prepare(`SELECT c.id, c.name, c.email, c.phone, co.name AS company_name FROM contacts c LEFT JOIN companies co ON co.id = c.company_id`).all() as unknown as AuditContact[]).map((r) => [r.id, r])) : undefined;
  if (arg("--out")) writeFileSync(arg("--out")!, JSON.stringify(report, null, 2));
  if (arg("--md")) writeFileSync(arg("--md")!, markdown(report, values));
  if (arg("--emit-review-sql")) writeFileSync(arg("--emit-review-sql")!, reviewSql(report));
  console.log(JSON.stringify({ contacts: report.contacts, groups: report.groups, byClass: report.byClass, invalidIdentifiers: report.invalidIdentifiers }));
}
