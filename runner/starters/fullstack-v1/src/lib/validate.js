// Input validation. Every public input is validated server-side; the browser's checks are a convenience only.
import { HttpError } from "./http.js";

/** Collects field problems and throws one 422 with all of them. */
export class Validator {
  constructor(input) { this.input = input ?? {}; this.problems = {}; this.out = {}; }
  fail(field, message) { this.problems[field] = message; return this; }
  str(field, { required = false, min = 0, max = 500, pattern = null, label = field } = {}) {
    const raw = this.input[field];
    const v = typeof raw === "string" ? raw.trim() : raw === undefined || raw === null ? "" : null;
    if (v === null) return this.fail(field, `${label} must be text.`);
    if (!v) { if (required) this.fail(field, `${label} is required.`); else this.out[field] = null; return this; }
    if (v.length < min) return this.fail(field, `${label} is too short.`);
    if (v.length > max) return this.fail(field, `${label} is too long (max ${max} characters).`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) return this.fail(field, `${label} contains invalid characters.`);
    if (pattern && !pattern.test(v)) return this.fail(field, `${label} is not valid.`);
    this.out[field] = v;
    return this;
  }
  email(field, opts = {}) { return this.str(field, { max: 254, pattern: /^[^\s@<>()",;:]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/, label: "Email", ...opts }); }
  phone(field, opts = {}) {
    this.str(field, { max: 32, pattern: /^[+()\d\s.-]{7,32}$/, label: "Phone", ...opts });
    if (this.out[field] && this.out[field].replace(/\D/g, "").length < 7) this.fail(field, "Phone is not valid.");
    return this;
  }
  oneOf(field, values, { required = false, label = field } = {}) {
    const v = this.input[field];
    if (v === undefined || v === null || v === "") { if (required) this.fail(field, `${label} is required.`); else this.out[field] = null; return this; }
    if (!values.includes(v)) return this.fail(field, `${label} is not one of the allowed values.`);
    this.out[field] = v;
    return this;
  }
  check(cond, field, message) { if (!cond) this.fail(field, message); return this; }
  done() {
    if (Object.keys(this.problems).length) throw new HttpError(422, "validation_failed", "Please correct the highlighted fields.", { fields: this.problems });
    return this.out;
  }
}

export const POSTAL_US = /^\d{5}(-\d{4})?$/;
