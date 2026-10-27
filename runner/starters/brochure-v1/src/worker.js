// Worker for the static site. Static files in public/ are served by the assets binding; this script only
// handles /api/* (wrangler.jsonc: assets.run_worker_first = ["/api/*"]).
//
// ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
// │ CONTACT FORM: UNCONFIGURED. No mail provider is connected, so submissions are validated and   │
// │ then refused with "not configured". Nothing is stored or sent. Connecting a provider is a     │
// │ separate, owner-approved step (credentials as Worker secrets, never in this repository).      │
// └──────────────────────────────────────────────────────────────────────────────────────────────┘

const MAX = { name: 120, email: 254, phone: 40, message: 5000 };

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function validate(fields) {
  const errors = {};
  const name = String(fields.get("name") ?? "").trim();
  const email = String(fields.get("email") ?? "").trim();
  const message = String(fields.get("message") ?? "").trim();
  const phone = String(fields.get("phone") ?? "").trim();
  if (!name || name.length > MAX.name) errors.name = "Please enter your name.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > MAX.email) errors.email = "Please enter a valid email address.";
  if (phone.length > MAX.phone) errors.phone = "Please shorten the phone number.";
  if (!message || message.length > MAX.message) errors.message = "Please enter a message.";
  return errors;
}

async function handleContact(request, env) {
  if (request.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  let fields;
  try {
    fields = await request.formData();
  } catch {
    return json(400, { ok: false, error: "Invalid form submission" });
  }
  // Honeypot: real visitors never fill this hidden field.
  if (String(fields.get("company_website") ?? "") !== "") return json(200, { ok: true });
  const errors = validate(fields);
  if (Object.keys(errors).length) return json(422, { ok: false, errors });

  const provider = (env && env.CONTACT_MAIL_PROVIDER) || "";
  if (!provider) {
    return json(503, {
      ok: false,
      configured: false,
      error: "The contact form is not connected yet. Please use the email address or phone number on this page.",
    });
  }
  // A provider name alone is not an integration: refuse until one is implemented and approved.
  return json(501, { ok: false, configured: false, error: `Mail provider "${provider}" is not implemented in this site yet.` });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/contact") return handleContact(request, env);
    if (url.pathname.startsWith("/api/")) return json(404, { ok: false, error: "Not found" });
    return env.ASSETS.fetch(request);
  },
};
