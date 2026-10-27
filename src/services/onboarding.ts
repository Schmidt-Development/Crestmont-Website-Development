// Guided, conditional onboarding (PORTAL-002, §19). Field definitions are data so the same rules
// drive rendering (data-show-when), server-side visibility and server-side validation on submit.
import type { AppContext } from "../app/context.ts";
import type { Db } from "../lib/db.ts";
import { nowIso } from "../lib/db.ts";
import { audit } from "./security.ts";
import { storeUpload, UploadError } from "./files.ts";
import { changeProjectStatus } from "./projects.ts";
import { notifyProjectTeam } from "./notifications.ts";
import { HttpError } from "../app/http.ts";
import { syncProjectBuildSafe } from "./builds.ts";

export type FieldType = "text" | "email" | "tel" | "url" | "textarea" | "select" | "radio" | "checkboxes" | "file";

export interface OnboardingField {
  name: string; label: string; type: FieldType; required?: boolean; hint?: string;
  options?: { value: string; label: string }[];
  /** Shown (and validated) only when another field holds one of these values. */
  showWhen?: { field: string; values: string[] };
  /** Shown only for these packages (product ids); omitted = all. */
  packages?: string[];
  max?: number;
}
export interface OnboardingSection { id: string; title: string; intro?: string; fields: OnboardingField[] }

const yesNo = [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }];

export const ONBOARDING_SECTIONS: OnboardingSection[] = [
  { id: "business", title: "Your business", fields: [
    { name: "business_name", label: "Business name", type: "text", required: true, max: 150 },
    { name: "contact_name", label: "Primary contact name", type: "text", required: true, max: 120 },
    { name: "contact_email", label: "Contact email", type: "email", required: true, max: 254 },
    { name: "contact_phone", label: "Contact phone", type: "tel", max: 40 },
    { name: "industry", label: "Industry", type: "text", required: true, max: 120 },
  ] },
  { id: "goals", title: "Goals and audience", fields: [
    { name: "goals", label: "What should the website achieve?", type: "textarea", required: true, hint: "For example: more quote requests, online bookings, product sales.", max: 3000 },
    { name: "target_audience", label: "Who is your target audience?", type: "textarea", required: true, max: 2000 },
  ] },
  { id: "branding", title: "Branding", fields: [
    { name: "has_branding", label: "Do you have existing branding (logo, colors, guidelines)?", type: "radio", required: true, options: yesNo },
    { name: "brand_guidelines", label: "Describe your brand or link to guidelines", type: "textarea", showWhen: { field: "has_branding", values: ["yes"] }, max: 3000 },
    { name: "logo", label: "Upload your logo", type: "file", showWhen: { field: "has_branding", values: ["yes"] }, hint: "PNG, JPG, WEBP or PDF. SVG is not accepted for security reasons; send a PDF or PNG instead." },
    { name: "brand_style", label: "What style should we aim for?", type: "textarea", required: true, showWhen: { field: "has_branding", values: ["no"] }, hint: "Words that describe the feel you want (e.g. classic, modern, warm).", max: 2000 },
    { name: "colors", label: "Preferred colors", type: "text", hint: "Hex codes or color names.", max: 300 },
  ] },
  { id: "pages", title: "Pages and functionality", fields: [
    { name: "pages", label: "Which pages do you need?", type: "textarea", required: true, hint: "List each page. Your package page limit applies; extra pages need a change order.", max: 3000 },
    { name: "functionality", label: "Desired functionality", type: "checkboxes", options: [
      { value: "contact_form", label: "Contact form" }, { value: "booking", label: "Booking or scheduling" }, { value: "ecommerce", label: "Online store" },
      { value: "blog", label: "Blog or news" }, { value: "newsletter", label: "Newsletter sign-up" }, { value: "other", label: "Something else" }] },
    { name: "booking_details", label: "Booking details", type: "textarea", required: true, showWhen: { field: "functionality", values: ["booking"] }, hint: "What is booked, by whom, and which calendar you use today.", max: 2000 },
    { name: "ecommerce_details", label: "Store details", type: "textarea", required: true, showWhen: { field: "functionality", values: ["ecommerce"] }, hint: "Approximate number of products, shipping, and payment provider if you have one.", max: 2000 },
    { name: "functionality_other", label: "Describe the other functionality", type: "textarea", required: true, showWhen: { field: "functionality", values: ["other"] }, max: 2000 },
    { name: "advanced_features", label: "Advanced layouts or interactions you want", type: "textarea", packages: ["premium", "custom"], max: 2000 },
    { name: "competitors", label: "Competitor or inspiration websites", type: "textarea", hint: "One URL per line, with what you like about each.", max: 2000 },
  ] },
  { id: "content", title: "Content and images", fields: [
    { name: "content_source", label: "Who will provide the written content?", type: "radio", required: true, options: [
      { value: "customer", label: "We will provide it" }, { value: "crestmont_draft", label: "Crestmont drafts it for our review" }, { value: "mix", label: "A mix" }] },
    { name: "content_notes", label: "Content notes", type: "textarea", showWhen: { field: "content_source", values: ["customer", "mix"] }, hint: "Where the content lives today and when it will be ready.", max: 2000 },
    { name: "images_source", label: "Images", type: "radio", required: true, options: [
      { value: "customer", label: "We will provide photos" }, { value: "licensed", label: "Use appropriately licensed imagery" }, { value: "mix", label: "A mix" }] },
    { name: "images", label: "Upload images", type: "file", showWhen: { field: "images_source", values: ["customer", "mix"] }, hint: "You can upload more later under Files." },
  ] },
  { id: "domain", title: "Domain and hosting", fields: [
    { name: "domain_status", label: "Do you already own a domain?", type: "radio", required: true, options: [
      { value: "own", label: "Yes, we own a domain" }, { value: "need", label: "No, we need one" }] },
    { name: "domain_name", label: "Domain name", type: "text", required: true, showWhen: { field: "domain_status", values: ["own"] }, max: 253 },
    { name: "dns_management", label: "Who should manage DNS?", type: "radio", required: true, showWhen: { field: "domain_status", values: ["own"] }, options: [
      { value: "self", label: "We keep managing DNS ourselves" }, { value: "agency", label: "Crestmont manages DNS for us (the domain stays ours)" }] },
    { name: "registrar", label: "Registrar / DNS provider", type: "text", showWhen: { field: "domain_status", values: ["own"] }, hint: "e.g. GoDaddy, Namecheap, Cloudflare. Never send passwords here; we will arrange access securely.", max: 120 },
    { name: "domain_wishes", label: "Domain names you would like", type: "text", required: true, showWhen: { field: "domain_status", values: ["need"] }, hint: "The domain will be registered in your name.", max: 300 },
    { name: "hosting", label: "Hosting preference", type: "radio", required: true, options: [
      { value: "crestmont", label: "Crestmont hosting and maintenance plan" }, { value: "own", label: "Our own hosting" }, { value: "undecided", label: "Not sure yet" }] },
    { name: "hosting_details", label: "Your hosting details", type: "textarea", required: true, showWhen: { field: "hosting", values: ["own"] }, hint: "Provider and plan. Do not include passwords.", max: 2000 },
  ] },
  { id: "integrations", title: "Integrations and instructions", fields: [
    { name: "integrations", label: "Integrations needed", type: "checkboxes", options: [
      { value: "analytics", label: "Analytics / Search Console" }, { value: "crm", label: "CRM" }, { value: "email_marketing", label: "Email marketing" },
      { value: "payments", label: "Payments" }, { value: "scheduling", label: "Scheduling" }, { value: "other", label: "Other" }] },
    { name: "integration_details", label: "Integration details", type: "textarea", required: true, showWhen: { field: "integrations", values: ["crm", "email_marketing", "payments", "scheduling", "other"] }, hint: "Which products you use (e.g. HubSpot, Mailchimp, Stripe).", max: 2000 },
    { name: "special_instructions", label: "Special instructions", type: "textarea", max: 3000 },
  ] },
];

export type Answers = Record<string, string | string[]>;

export function allFields(productId: string | null): OnboardingField[] {
  return ONBOARDING_SECTIONS.flatMap((s) => s.fields).filter((f) => !f.packages || f.packages.includes(productId ?? "custom"));
}

export function isVisible(f: OnboardingField, a: Answers): boolean {
  if (!f.showWhen) return true;
  const v = a[f.showWhen.field];
  const vals = Array.isArray(v) ? v : v ? [v] : [];
  return vals.some((x) => f.showWhen!.values.includes(x));
}

/** Server-side validation of a submission. Only visible fields are required; hidden ones are dropped. */
export function validateOnboarding(productId: string | null, a: Answers, final: boolean): { errors: string[]; clean: Answers } {
  const errors: string[] = [];
  const clean: Answers = {};
  for (const f of allFields(productId)) {
    if (f.type === "file") { if (a[f.name]) clean[f.name] = a[f.name]; continue; }
    if (!isVisible(f, a)) continue;
    const raw = a[f.name];
    if (f.type === "checkboxes") {
      const vals = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((x) => f.options!.some((o) => o.value === x));
      if (vals.length) clean[f.name] = vals;
      continue;
    }
    const s = (Array.isArray(raw) ? raw[0] : raw ?? "").trim();
    if (!s) { if (final && f.required) errors.push(`${f.label} is required`); continue; }
    if (f.max && s.length > f.max) { errors.push(`${f.label} must be at most ${f.max} characters`); continue; }
    if ((f.type === "select" || f.type === "radio") && !f.options!.some((o) => o.value === s)) { errors.push(`${f.label} has an invalid choice`); continue; }
    if (f.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) { errors.push(`${f.label} must be a valid email address`); continue; }
    if (f.name === "domain_name" && !/^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/i.test(s)) { errors.push("Domain name must look like example.com"); continue; }
    clean[f.name] = s;
  }
  return { errors, clean };
}

export interface OnboardingRecord { answers: Answers; completed_at: string | null; updated_at: string }

export async function getOnboarding(db: Db, projectId: string): Promise<OnboardingRecord | null> {
  const r = await db.prepare(`SELECT answers_json, completed_at, updated_at FROM onboarding_responses WHERE project_id = ?`).bind(projectId).first<{ answers_json: string; completed_at: string | null; updated_at: string }>();
  if (!r) return null;
  let answers: Answers = {};
  try { answers = JSON.parse(r.answers_json); } catch { /* keep empty */ }
  return { answers, completed_at: r.completed_at, updated_at: r.updated_at };
}

/** Reads the posted form into answers (multi-value for checkboxes); file inputs are handled separately. */
export function answersFromForm(productId: string | null, form: FormData): Answers {
  const out: Answers = {};
  for (const f of allFields(productId)) {
    if (f.type === "file") continue;
    if (f.type === "checkboxes") out[f.name] = form.getAll(f.name).filter((x): x is string => typeof x === "string");
    else { const v = form.get(f.name); if (typeof v === "string") out[f.name] = v; }
  }
  return out;
}

export class OnboardingError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) { super(errors.join("; ")); this.errors = errors; }
}

/** Save a draft or submit. Submit validates conditionally, completes onboarding and moves awaiting_onboarding → scope_review. */
export async function saveOnboarding(ctx: AppContext, input: { organizationId: string; projectId: string; userId: string; form: FormData; submit: boolean }): Promise<{ completed: boolean }> {
  const p = await ctx.db.prepare(`SELECT id, status, product_id FROM projects WHERE id = ? AND organization_id = ?`).bind(input.projectId, input.organizationId).first<{ id: string; status: string; product_id: string | null }>();
  if (!p) throw new HttpError(404, "Project not found");
  const existing = await getOnboarding(ctx.db, p.id);
  if (existing?.completed_at) throw new OnboardingError(["Onboarding was already submitted. Send changes to your team through Messages."]);
  if (!["purchased", "awaiting_onboarding"].includes(p.status)) throw new OnboardingError(["Onboarding is not open for this project."]);
  const answers: Answers = { ...(existing?.answers ?? {}), ...answersFromForm(p.product_id, input.form) };
  // Uploads (logo, images) go through the private file service.
  const uploadErrors: string[] = [];
  for (const name of ["logo", "images"]) {
    const files = input.form.getAll(name).filter((x): x is File => typeof x !== "string" && x.size > 0);
    const ids = Array.isArray(answers[name]) ? [...(answers[name] as string[])] : [];
    for (const file of files) {
      try {
        ids.push((await storeUpload(ctx, { organizationId: input.organizationId, projectId: p.id, file, uploadedBy: input.userId, folder: name === "logo" ? "Onboarding/Logo" : "Onboarding/Images" })).id);
      } catch (e) {
        if (e instanceof UploadError) uploadErrors.push(`${file.name}: ${e.message}`); else throw e;
      }
    }
    if (ids.length) answers[name] = ids;
  }
  const { errors, clean } = validateOnboarding(p.product_id, answers, input.submit);
  const allErrors = [...uploadErrors, ...errors];
  const at = nowIso();
  // Drafts persist whatever is valid even when the submit fails, so nothing typed is lost.
  await ctx.db.batch([
    ctx.db.prepare(`INSERT INTO onboarding_responses (project_id, answers_json, updated_at) VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET answers_json = excluded.answers_json, updated_at = excluded.updated_at`)
      .bind(p.id, JSON.stringify(clean), at),
    ctx.db.prepare(`UPDATE projects SET last_customer_activity_at = ?, updated_at = ? WHERE id = ?`).bind(at, at, p.id),
  ]);
  if (allErrors.length) throw new OnboardingError(allErrors);
  if (!input.submit) {
    await audit(ctx.db, { actorUserId: input.userId, action: "onboarding.draft_saved", subjectType: "project", subjectId: p.id, organizationId: input.organizationId });
    return { completed: false };
  }
  await ctx.db.prepare(`UPDATE onboarding_responses SET completed_at = ? WHERE project_id = ? AND completed_at IS NULL`).bind(at, p.id).run();
  await audit(ctx.db, { actorUserId: input.userId, action: "onboarding.completed", subjectType: "project", subjectId: p.id, organizationId: input.organizationId });
  if (p.status === "purchased") await changeProjectStatus(ctx, p.id, "awaiting_onboarding", { actorUserId: input.userId, actorKind: "user" });
  await changeProjectStatus(ctx, p.id, "scope_review", { actorUserId: input.userId, actorKind: "user", note: "Onboarding completed by customer" });
  await syncProjectBuildSafe(ctx.db, p.id, "intake");
  await notifyProjectTeam(ctx, p.id, { kind: "onboarding_completed", template: "onboarding", subject: "Customer onboarding completed", pmOnly: true,
    body: "The customer submitted onboarding. The project is now in scope review.", path: `/staff/projects/${p.id}`, key: `onb:${p.id}` });
  return { completed: true };
}
