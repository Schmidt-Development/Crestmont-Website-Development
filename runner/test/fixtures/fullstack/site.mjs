// TEST FIXTURE ONLY: writes the pages a builder would write for a business configuration, so the full-stack gates
// and the cross-industry scenarios can be exercised offline. Production websites are written by the AI builder;
// nothing here is used by the runner at build time.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function buildFixtureSite(starterDir, dest, config, brand = {}) {
  cpSync(starterDir, dest, { recursive: true });
  writeFileSync(path.join(dest, "business.config.json"), JSON.stringify(config, null, 2) + "\n");
  const b = config.business;
  const f = config.features;
  const pages = [["index.html", "Home"], ["services.html", "Services"], ["contact.html", "Contact"]];
  if (f.quotes) pages.push(["quote.html", "Get a quote"]);
  if (f.booking) pages.push(["book.html", "Book online"]);
  const nav = (cur) => `<nav class="site-nav" aria-label="Main"><ul id="site-menu">${pages.map(([p, l]) => `<li><a href="/${p === "index.html" ? "" : p}"${p === cur ? ' aria-current="page"' : ""}>${esc(l)}</a></li>`).join("")}<li><a href="/booking/manage.html">Manage a booking</a></li></ul></nav>`;
  const page = (file, label, body, extraHead = "") => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(label)} | ${esc(b.name)}</title>
  <meta name="description" content="${esc(`${label}: ${b.description}`.slice(0, 155))}">
  <link rel="canonical" href="/${file === "index.html" ? "" : file}">
  <meta property="og:title" content="${esc(`${label} | ${b.name}`)}">
  <meta property="og:description" content="${esc(b.description)}">
  <link rel="stylesheet" href="/assets/tokens.css">
  <link rel="stylesheet" href="/assets/site.css">
  ${extraHead}
  <script src="/assets/app.js" defer></script>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header"><div class="container"><a class="brand" href="/">${esc(b.name)}</a><button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-menu">Menu</button>${nav(file)}</div></header>
  <main id="main">${body}</main>
  <footer class="site-footer"><div class="container"><p>${esc(b.name)} · <a href="tel:${esc(b.phone.replace(/[^+\d]/g, ""))}">${esc(b.phone)}</a> · <a href="mailto:${esc(b.email)}">${esc(b.email)}</a></p></div></footer>
</body>
</html>
`;
  const services = config.services.map((s) => `<article class="card"><h3>${esc(s.name)}</h3><p>${esc(s.description)}</p><p class="price">${s.priceCents ? `$${(s.priceCents / 100).toFixed(2)}` : esc(s.priceNote ?? "")}</p></article>`).join("");
  const ld = `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "LocalBusiness", name: b.name, description: b.description, telephone: b.phone, email: b.email })}</script>`;
  const out = {
    "index.html": page("index.html", "Home", `<section class="hero"><div class="container"><h1>${esc(b.name)}</h1><p>${esc(b.description)}</p></div></section><section class="section"><div class="container"><h2>Services</h2><div class="grid three">${services}</div></div></section>`, ld),
    "services.html": page("services.html", "Services", `<section class="section"><div class="container"><h1>Services</h1><div class="grid three">${services}</div></div></section>`),
    "contact.html": page("contact.html", "Contact", `<section class="section"><div class="container"><h1>Contact us</h1><form data-api="/api/contact" class="card"><div class="status" role="status" tabindex="-1"></div>
<div class="field"><label for="c-name">Name</label><input id="c-name" name="name" required autocomplete="name"></div>
<div class="field"><label for="c-email">Email</label><input id="c-email" name="email" type="email" required autocomplete="email"></div>
<div class="field"><label for="c-phone">Phone</label><input id="c-phone" name="phone" type="tel" autocomplete="tel"></div>
<div class="field"><label for="c-message">Message</label><textarea id="c-message" name="message" required></textarea></div>
<input class="hp-field" name="website" tabindex="-1" autocomplete="off" aria-label="Leave empty">
<button type="submit">Send</button></form></div></section>`),
  };
  if (f.quotes) out["quote.html"] = page("quote.html", "Get a quote", `<section class="section"><div class="container"><h1>Get a free quote</h1><form data-api="/api/quotes" class="card" data-success="Thank you. We will contact you with a quote."><div class="status" role="status" tabindex="-1"></div>
<div class="field"><label for="q-name">Name</label><input id="q-name" name="name" required></div>
<div class="field"><label for="q-email">Email</label><input id="q-email" name="email" type="email" required></div>
<div class="field"><label for="q-phone">Phone</label><input id="q-phone" name="phone" type="tel"></div>
<div class="field"><label for="q-zip">ZIP code</label><input id="q-zip" name="postalCode" inputmode="numeric"></div>
<div class="field"><label for="q-city">City</label><input id="q-city" name="city"></div>
<div class="field"><label for="q-details">What do you need?</label><textarea id="q-details" name="details" required></textarea></div>
<button type="submit">Request a quote</button></form></div></section>`);
  if (f.booking) out["book.html"] = page("book.html", "Book online", `<section class="section"><div class="container" data-booking><h1>Book online</h1><div class="status" role="status" tabindex="-1"></div>
<div class="field"><label for="b-service">Service</label><select id="b-service" name="serviceId"></select></div>
<div class="field"><label for="b-date">Date</label><input id="b-date" name="date" type="date"></div>
<div class="slots" aria-live="polite"></div>
<form hidden class="card"><div class="field"><label for="b-name">Name</label><input id="b-name" name="name" required></div>
<div class="field"><label for="b-email">Email</label><input id="b-email" name="email" type="email" required></div>
<div class="field"><label for="b-phone">Phone</label><input id="b-phone" name="phone" type="tel"></div>
<div class="field"><label for="b-address">Address</label><input id="b-address" name="address"></div>
<div class="field"><label for="b-zip">ZIP code</label><input id="b-zip" name="postalCode"></div>
<div class="field"><label for="b-notes">Notes</label><textarea id="b-notes" name="notes"></textarea></div>
<button type="submit">Book</button></form></div></section>`);
  for (const [file, html] of Object.entries(out)) writeFileSync(path.join(dest, "public", file), html);
  for (const file of ["booking/manage.html", "booking/confirmation.html", "404.html"]) {
    const p = path.join(dest, "public", file);
    writeFileSync(p, readFileSync(p, "utf8").replaceAll("STARTER-PLACEHOLDER Business name", b.name));
  }
  const tokens = path.join(dest, "public", "assets", "tokens.css");
  let t = readFileSync(tokens, "utf8").replace("STARTER-PLACEHOLDER: replace these defaults with the brand.", "Brand applied.");
  for (const [k, v] of Object.entries(brand)) t = t.replace(new RegExp(`(--${k}:\\s*)#[0-9a-fA-F]{3,6}`), `$1${v}`);
  writeFileSync(tokens, t);
  writeFileSync(path.join(dest, "public", "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${Object.keys(out).map((p) => `  <url><loc>/${p === "index.html" ? "" : p}</loc></url>`).join("\n")}\n</urlset>\n`);
  mkdirSync(path.join(dest, ".crestmont"), { recursive: true });
  return dest;
}
