// Administration dashboard: sign-in, overview, records per tab with their actions. All data comes from /api/admin/*.
const $ = (s, r = document) => r.querySelector(s);
const status = $(".status");
const say = (kind, text) => { status.dataset.kind = kind; status.textContent = text; };

async function api(path, body) {
  const res = await fetch(path, { method: body ? "POST" : "GET", credentials: "same-origin", headers: { "x-requested-with": "fetch", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { /* empty */ }
  return { ok: res.ok, status: res.status, data };
}

const money = (c, cur = "usd") => new Intl.NumberFormat(undefined, { style: "currency", currency: cur.toUpperCase() }).format((c ?? 0) / 100);
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "");
const cell = (v) => { const td = document.createElement("td"); td.textContent = v ?? ""; return td; };

const COLUMNS = {
  bookings: [["Reference", (r) => r.reference], ["When", (r) => when(r.start_at)], ["Service", (r) => r.service], ["Customer", (r) => `${r.customer_name} · ${r.customer_email}${r.customer_phone ? ` · ${r.customer_phone}` : ""}`], ["ZIP", (r) => r.postal_code], ["Status", (r) => r.status]],
  quotes: [["Reference", (r) => r.reference], ["Received", (r) => when(r.created_at)], ["From", (r) => `${r.name} · ${r.email}${r.phone ? ` · ${r.phone}` : ""}`], ["Area", (r) => [r.city, r.postal_code].filter(Boolean).join(" ")], ["Details", (r) => r.details], ["Status", (r) => r.status]],
  messages: [["Received", (r) => when(r.created_at)], ["From", (r) => `${r.name} · ${r.email}`], ["Message", (r) => r.message], ["Status", (r) => r.status]],
  payments: [["Booking", (r) => r.reference], ["Amount", (r) => money(r.amount_cents, r.currency)], ["Refunded", (r) => (r.refunded_cents ? money(r.refunded_cents, r.currency) : "")], ["Mode", (r) => r.mode], ["Status", (r) => r.status], ["Created", (r) => when(r.created_at)]],
  notifications: [["Created", (r) => when(r.created_at)], ["To", (r) => r.to_address], ["Template", (r) => r.template], ["Status", (r) => r.status], ["Attempts", (r) => r.attempts], ["Error", (r) => r.last_error]],
  audit: [["When", (r) => when(r.at)], ["Who", (r) => r.actor], ["Action", (r) => r.action], ["Subject", (r) => [r.subject_type, r.subject_id].filter(Boolean).join(" ")]],
};
const ACTIONS = {
  bookings: (r) => (r.status === "confirmed" ? [["Complete", `/api/admin/bookings/${r.id}/complete`], ["No-show", `/api/admin/bookings/${r.id}/no_show`], ["Cancel", `/api/admin/bookings/${r.id}/cancel`]] : r.status === "pending_payment" ? [["Cancel", `/api/admin/bookings/${r.id}/cancel`]] : []),
  quotes: (r) => ["contacted", "quoted", "won", "lost"].filter((s) => s !== r.status).map((s) => [s[0].toUpperCase() + s.slice(1), `/api/admin/quotes/${r.id}/status`, { status: s }]),
  messages: (r) => (r.status === "new" ? [["Answered", `/api/admin/messages/${r.id}/status`, { status: "answered" }], ["Archive", `/api/admin/messages/${r.id}/status`, { status: "archived" }]] : []),
  payments: (r) => (r.status === "pending" ? [["Check with Stripe", `/api/admin/payments/${r.id}/reconcile`]] : []),
};

async function show(tab) {
  for (const b of document.querySelectorAll("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  const panel = $("#panel");
  panel.textContent = "Loading…";
  const r = await api(`/api/admin/${tab}`);
  if (!r.ok) { panel.textContent = r.data?.error?.message ?? "Could not load."; return; }
  if (!r.data.items.length) { panel.replaceChildren(Object.assign(document.createElement("p"), { className: "empty", textContent: "Nothing here yet." })); return; }
  const table = document.createElement("table");
  table.className = "admin-table";
  const head = table.createTHead().insertRow();
  for (const [h] of COLUMNS[tab]) { const th = document.createElement("th"); th.scope = "col"; th.textContent = h; head.append(th); }
  if (ACTIONS[tab]) head.append(Object.assign(document.createElement("th"), { scope: "col", textContent: "Actions" }));
  const body = table.createTBody();
  for (const row of r.data.items) {
    const tr = body.insertRow();
    for (const [, f] of COLUMNS[tab]) tr.append(cell(f(row)));
    if (ACTIONS[tab]) {
      const td = document.createElement("td");
      for (const [label, path, payload] of ACTIONS[tab](row)) {
        const b = Object.assign(document.createElement("button"), { type: "button", className: "button secondary", textContent: label });
        b.addEventListener("click", async () => {
          b.disabled = true;
          const res = await api(path, payload ?? {});
          b.disabled = false;
          say(res.ok ? "success" : "error", res.ok ? `${label}: done.` : res.data?.error?.message ?? "Failed.");
          if (res.ok) { show(tab); stats(); }
        });
        td.append(b, " ");
      }
      tr.append(td);
    }
  }
  panel.replaceChildren(table);
}

async function stats() {
  const r = await api("/api/admin/dashboard");
  if (!r.ok) return;
  const d = r.data;
  const items = [["Upcoming bookings", d.upcomingBookings], ["New quote requests", d.newQuotes], ["New messages", d.newMessages], ["Payments received", money(d.paidCents)], ["Emails waiting", d.emailsQueued], ["Emails failed", d.emailsFailed]];
  $("#stats").replaceChildren(...items.map(([k, v]) => { const c = document.createElement("div"); c.className = "card"; c.innerHTML = ""; c.append(Object.assign(document.createElement("strong"), { textContent: String(v) }), document.createElement("br"), k); return c; }));
  if (!d.mailConfigured) say("info", "Email is not configured yet: confirmation emails are waiting and will be sent once the mail provider is connected.");
}

async function start() {
  const me = await api("/api/admin/me");
  if (!me.ok) { $("#login").hidden = false; $("#app").hidden = true; return; }
  $("#login").hidden = true; $("#app").hidden = false;
  $("#whoami").textContent = `Signed in as ${me.data.user.name} (${me.data.user.role}).`;
  if (me.data.user.role !== "owner") document.querySelector('[data-tab="audit"]').hidden = true;
  await stats();
  await show("bookings");
}

document.addEventListener("DOMContentLoaded", () => {
  $("#login").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const r = await api("/api/admin/login", Object.fromEntries(new FormData(ev.target).entries()));
    if (!r.ok) { say("error", r.data?.error?.message ?? "Could not sign in."); return; }
    say("success", "");
    start();
  });
  for (const b of document.querySelectorAll("[data-tab]")) b.addEventListener("click", () => show(b.dataset.tab));
  $("#logout").addEventListener("click", async () => { await api("/api/admin/logout", {}); start(); });
  start();
});
