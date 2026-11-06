// Summit Haul Co. — the backend for the quote form the Founder's frontend already has.
//
// Real persistence, real validation, real failure. There is no "pretend it worked" branch: if the insert throws,
// the visitor is told it did not save. A form that always says "thank you" is worse than no form, because the
// business never learns the lead was lost.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SCHEMA = path.join(import.meta.dirname, "schema.sql");

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA, "utf8"));
  return db;
}

const LOAD_SIZES = new Set([
  "Quarter truck — $95",
  "Half truck — $210",
  "Three-quarter truck — $340",
  "Full truck — $480",
  "Not sure yet",
]);

const str = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * Validate a submission.
 *
 * Server-side, and not a mirror of the browser's `required` attributes: those are a convenience for the visitor
 * and absent entirely from a direct POST. Returns a map of field -> message so the frontend can put each message
 * beside its own input rather than showing one vague banner.
 */
export function validate(body) {
  const errors = {};
  const name = str(body?.name);
  const phone = str(body?.phone);
  const email = str(body?.email);
  const postcode = str(body?.postcode);
  const loadSize = str(body?.load_size);
  const details = str(body?.details);

  if (name.length < 2) errors.name = "Please tell us your name.";
  else if (name.length > 120) errors.name = "That name is too long.";

  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) errors.phone = "Please give a phone number we can reach you on.";

  // Deliberately permissive: the only thing worth refusing is an address that cannot be sent to at all.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = "Please check the email address.";
  else if (email.length > 254) errors.email = "That email address is too long.";

  if (!/^\d{5}$/.test(postcode)) errors.postcode = "A five-digit ZIP code, please.";

  if (!loadSize) errors.load_size = "Choose a rough load size.";
  else if (!LOAD_SIZES.has(loadSize)) errors.load_size = "That is not one of the load sizes we quote.";

  if (details.length > 4000) errors.details = "Please keep the description under 4000 characters.";

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    value: { name, phone, email, postcode, load_size: loadSize, details },
  };
}

export function insertQuoteRequest(db, value) {
  const id = `qr_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  db.prepare(
    `INSERT INTO quote_requests (id, name, phone, email, postcode, load_size, details, status, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'new', 'website', ?)`,
  ).run(id, value.name, value.phone, value.email, value.postcode, value.load_size, value.details || null, new Date().toISOString());
  return id;
}

const json = (res, status, body) => {
  const b = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(b), "cache-control": "no-store" });
  res.end(b);
};

async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("payload too large");
    chunks.push(c);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Handle POST /api/quote-requests. Returns true when it handled the request.
 *
 * `db` is passed in rather than opened here so a test can hand it a database that fails on purpose — the error
 * path has to be exercised, not assumed.
 */
export async function handleApi(req, res, db) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/api/quote-requests") return false;

  if (req.method !== "POST") {
    json(res, 405, { error: "method_not_allowed", message: "Send a POST." });
    return true;
  }

  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    json(res, 400, { error: "bad_request", message: String(err.message).includes("too large") ? "That submission is too large." : "The submission could not be read." });
    return true;
  }

  const checked = validate(body);
  if (!checked.ok) {
    json(res, 422, { error: "validation_failed", message: "Please check the highlighted fields.", fields: checked.errors });
    return true;
  }

  let id;
  try {
    id = insertQuoteRequest(db, checked.value);
  } catch (err) {
    // The visitor is told the truth and given another way through. Nothing pretends this succeeded.
    console.error(`quote request not stored: ${String(err && err.message).slice(0, 300)}`);
    json(res, 503, {
      error: "not_stored",
      message: "We could not save your request just now. Please call (517) 555-0123 and we will take it down.",
    });
    return true;
  }

  json(res, 201, { id, status: "new", message: "Thank you — we have your request and will come back with a quote today." });
  return true;
}
