// Release acceptance of the automatic display system on real websites (Owner, 2026-11-16: "use https://premiuminvoices.com/,
// https://lendingforbeginners.com/ and https://leadhavencollective.com/ … Test the normal Add workflow including
// automatic mode selection"). For each address it runs the same steps as Staff → Portfolio → Add a project — read the
// page once, pre-fill name/slug/description, create the project UNPUBLISHED, check it and select its display (the native
// embed, or the honest unavailable notice — never a remote stream since 2026-11-19) — or,
// when a project for that site already exists, only re-checks it. Then it issues a one-hour, view-only preview link so
// the release pipeline can drive the result in a real browser. Nothing is published, no relationship or consent is
// recorded (those stay for a person with the owner's documentation), and the destination websites are never changed.
import type { Db } from "../lib/db.ts";
import type { Actor } from "../domain/authz.ts";
import { checkEmbed, safePublicUrl } from "./embed-check.ts";
import * as pf from "./portfolio.ts";
import { siteOf } from "./remote-browser/policy.ts";
import { issuePreviewToken } from "./remote-browser/connect.ts";

export interface IntakeRow { url: string; slug: string | null; id: string | null; created: boolean; status: string; mode: string; reason: string; published: boolean; preview: string | null; error?: string }

/** The release pipeline acts as the system, with the Owner's portfolio permission for this one purpose. */
const SYSTEM: Actor = { kind: "system", roles: [{ role: "owner", organizationId: "org_crestmont" }], mfaVerified: true };

const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);

export async function intakeForAcceptance(db: Db, origin: string, fetcher: typeof fetch, remoteEnabled: boolean, urls: string[], now = Date.now()): Promise<IntakeRow[]> {
  const out: IntakeRow[] = [];
  for (const raw of urls.slice(0, 5)) {
    const u = safePublicUrl(String(raw));
    const site = u ? siteOf(u.toString()) : null;
    if (!u || !site) { out.push({ url: String(raw).slice(0, 200), slug: null, id: null, created: false, status: "error", mode: "unavailable", reason: "Not a public https address.", published: false, preview: null, error: "invalid" }); continue; }
    const existing = (await pf.listActive(db)).find((p) => siteOf(p.live_url) === site);
    let id: string, created = false;
    if (existing) {
      id = existing.id;
      await pf.refreshEmbed(db, existing, origin, fetcher, null, remoteEnabled);
    } else {
      // Step 2 of the staff flow: what the page says about itself.
      const check = await checkEmbed(u.toString(), origin, fetcher);
      const name = ((check.siteName ?? check.title?.split(/\s+[—–|·-]\s+/)[0] ?? "").trim() || site).slice(0, 120);
      let slug = slugify(name) || slugify(site);
      for (let n = 2; await pf.getBySlug(db, slug); n++) slug = `${slugify(name) || slugify(site)}-${n}`;
      const description = (check.description ?? "").trim().length >= 20 ? check.description!.trim().slice(0, 4000)
        : `${name} — the live website at ${site}. Added for review; the description and features are to be confirmed by staff before publishing.`;
      ({ id } = await pf.createProject(db, SYSTEM, { name, slug, industry: "To be confirmed by staff", live_url: check.url ?? u.toString(), description, features: "", technology_summary: "", relationship: "Relationship documentation pending" }));
      // One native-first standard (2026-11-19): acceptance entries follow it like every other entry (never streamed).
      await pf.recordEmbedCheck(db, id, check, null, remoteEnabled);
      created = true;
    }
    const p = (await pf.getById(db, id))!;
    out.push({ url: u.toString(), slug: p.slug, id, created, status: p.embed_status ?? "unchecked", mode: p.display_mode ?? "unchecked", reason: p.display_reason ?? "", published: !!p.published,
      preview: await issuePreviewToken(db, id, 60, "release-acceptance", now) });
  }
  return out;
}
