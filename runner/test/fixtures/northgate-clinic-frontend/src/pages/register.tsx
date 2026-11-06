import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Field, Layout } from "../components/Layout";
import "../styles.css";

type Errors = Partial<Record<"name" | "email" | "password" | "confirm" | "terms", string>>;

/** Account creation, as approved. Validation real, submission inert: creating an account needs a backend. */
function Register() {
  const [errors, setErrors] = useState<Errors>({});

  return (
    <Layout current="/register.html">
      <section className="section" style={{ paddingTop: 64 }}>
        <div className="shell form-narrow">
          <h1>Create an account</h1>
          <p className="lede">So you can see your appointments, reschedule them, and keep your details in one place.</p>

          <form
            id="register"
            noValidate
            style={{ marginTop: 32 }}
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const get = (k: string) => String(data.get(k) ?? "").trim();
              const e: Errors = {};
              if (get("name").length < 2) e.name = "Please give your name.";
              if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(get("email"))) e.email = "That does not look like an email address.";
              if (get("password").length < 12) e.password = "Twelve characters or more, please.";
              if (get("confirm") !== get("password")) e.confirm = "The two passwords do not match.";
              if (!data.get("terms")) e.terms = "Please accept the practice policy.";
              setErrors(e);
              // No endpoint yet. The form does not pretend to have made an account.
            }}
          >
            <Field label="Your name" error={errors.name}>
              <input name="name" type="text" autoComplete="name" required />
            </Field>
            <Field label="Email" hint="This is also how you sign in." error={errors.email}>
              <input name="email" type="email" autoComplete="email" required />
            </Field>
            <Field label="Password" hint="At least 12 characters." error={errors.password}>
              <input name="password" type="password" autoComplete="new-password" required />
            </Field>
            <Field label="Confirm password" error={errors.confirm}>
              <input name="confirm" type="password" autoComplete="new-password" required />
            </Field>

            <label className={errors.terms ? "field invalid" : "field"} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <input name="terms" type="checkbox" style={{ width: 18, height: 18, marginTop: 4 }} />
              <span style={{ fontWeight: 400, marginBottom: 0 }}>
                I accept the practice policy on cancellations and late arrivals.
                {errors.terms ? <span className="error">{errors.terms}</span> : null}
              </span>
            </label>

            <button className="btn" type="submit" style={{ width: "100%" }}>Create account</button>
          </form>

          <p style={{ marginTop: 20, color: "var(--ink-soft)" }}>
            Already registered? <a href="/login.html">Sign in</a>.
          </p>
        </div>
      </section>
    </Layout>
  );
}

createRoot(document.getElementById("root")!).render(<Register />);
