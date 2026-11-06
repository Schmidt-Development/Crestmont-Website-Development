import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Field, Layout } from "../components/Layout";
import "../styles.css";

const TREATMENTS = ["Examination and x-rays", "Hygienist clean", "Filling", "Crown consultation", "Whitening consultation", "Something is hurting"];
const TIMES = ["Morning (8am-12pm)", "Afternoon (12pm-5pm)", "Evening (5pm-8pm, Tue/Thu)"];

type Errors = Partial<Record<"name" | "email" | "phone" | "treatment" | "date" | "window", string>>;

/**
 * The appointment request form, as approved.
 *
 * Validation is real: it is part of the approved design and runs entirely in the browser. Submission is INERT —
 * there is nowhere to send it. The import's interaction inventory should mark this form as needing a backend, and
 * the manifest asks for exactly that: persist the request, refuse an invalid one, and never show a confirmation
 * for something that was not stored.
 */
function Book() {
  const [errors, setErrors] = useState<Errors>({});

  const validate = (form: HTMLFormElement): Errors => {
    const data = new FormData(form);
    const get = (k: string) => String(data.get(k) ?? "").trim();
    const e: Errors = {};
    if (get("name").length < 2) e.name = "Please give the name the appointment is for.";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(get("email"))) e.email = "We need an email address to confirm the appointment.";
    if (get("phone").replace(/[^0-9]/g, "").length < 10) e.phone = "A phone number with at least 10 digits, please.";
    if (!get("treatment")) e.treatment = "Choose what the appointment is for.";
    if (!get("date")) e.date = "Choose a preferred date.";
    else if (get("date") < new Date().toISOString().slice(0, 10)) e.date = "That date has passed.";
    if (!get("window")) e.window = "Choose a time of day.";
    return e;
  };

  return (
    <Layout current="/book.html">
      <section className="hero" style={{ paddingTop: 64, paddingBottom: 64 }}>
        <div className="shell" style={{ gridTemplateColumns: "1fr" }}>
          <div>
            <p className="eyebrow">Appointments</p>
            <h1>Book an appointment</h1>
            <p className="lede">Tell us what you need and when suits. Most requests are confirmed the same working day.</p>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="shell form-narrow">
          <form
            id="appointment-request"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              // Captured before anything async: `currentTarget` is null by the time an await resolves.
              const form = event.currentTarget;
              setErrors(validate(form));
              // Nothing further: there is no endpoint yet. A confirmation shown here would be a lie.
            }}
          >
            <Field label="Patient name" error={errors.name}>
              <input name="name" type="text" autoComplete="name" required />
            </Field>

            <div className="row">
              <Field label="Email" error={errors.email}>
                <input name="email" type="email" autoComplete="email" required />
              </Field>
              <Field label="Phone" error={errors.phone}>
                <input name="phone" type="tel" autoComplete="tel" required />
              </Field>
            </div>

            <Field label="What is it for?" error={errors.treatment}>
              <select name="treatment" defaultValue="" required>
                <option value="" disabled>Choose a treatment</option>
                {TREATMENTS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>

            <div className="row">
              <Field label="Preferred date" error={errors.date}>
                <input name="date" type="date" required />
              </Field>
              <Field label="Time of day" error={errors.window}>
                <select name="window" defaultValue="" required>
                  <option value="" disabled>Choose a time</option>
                  {TIMES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>
            </div>

            <Field label="Anything we should know?" hint="Optional. Pain, nervousness, a tooth that broke — anything useful.">
              <textarea name="notes" />
            </Field>

            <button className="btn" type="submit" style={{ width: "100%" }}>Request this appointment</button>
            <p style={{ color: "var(--ink-soft)", fontSize: "0.9375rem", marginTop: 14, marginBottom: 0 }}>
              Requesting an appointment does not confirm it. We will email you to confirm the time.
            </p>
          </form>
        </div>
      </section>
    </Layout>
  );
}

createRoot(document.getElementById("root")!).render(<Book />);
