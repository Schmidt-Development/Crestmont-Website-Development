import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Field, Layout } from "../components/Layout";
import "../styles.css";

type Errors = Partial<Record<"name" | "email" | "address" | "postcode" | "password" | "agree", string>>;

/** Membership application, as approved. Validation real, submission inert. */
function Join() {
  const [errors, setErrors] = useState<Errors>({});

  return (
    <Layout current="/join.html">
      <section className="masthead">
        <div className="shell">
          <p className="eyebrow">Membership</p>
          <h1>Join the library</h1>
          <p className="lede">£35 a year for everyone at your address. Three items at a time, seven days each.</p>
        </div>
      </section>

      <section className="section">
        <div className="shell" style={{ maxWidth: 620 }}>
          <form
            id="join"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const get = (k: string) => String(data.get(k) ?? "").trim();
              const e: Errors = {};
              if (get("name").length < 2) e.name = "Please give your name.";
              if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(get("email"))) e.email = "That does not look like an email address.";
              if (get("address").length < 5) e.address = "We need an address in Riverbend or the surrounding parishes.";
              if (!/^[A-Za-z0-9 ]{5,9}$/.test(get("postcode"))) e.postcode = "Please give a valid postcode.";
              if (get("password").length < 12) e.password = "Twelve characters or more, please.";
              if (!data.get("agree")) e.agree = "Please accept the borrowing rules.";
              setErrors(e);
              // No endpoint: nothing is created and no confirmation is shown.
            }}
          >
            <Field label="Your name" error={errors.name}>
              <input name="name" type="text" autoComplete="name" required />
            </Field>
            <Field label="Email" hint="This is also how you sign in." error={errors.email}>
              <input name="email" type="email" autoComplete="email" required />
            </Field>
            <Field label="Address" error={errors.address}>
              <input name="address" type="text" autoComplete="street-address" required />
            </Field>
            <div className="row">
              <Field label="Postcode" error={errors.postcode}>
                <input name="postcode" type="text" autoComplete="postal-code" required />
              </Field>
              <Field label="Password" hint="At least 12 characters." error={errors.password}>
                <input name="password" type="password" autoComplete="new-password" required />
              </Field>
            </div>

            <label className={errors.agree ? "field invalid" : "field"} style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
              <input name="agree" type="checkbox" style={{ width: 16, height: 16, marginTop: 4 }} />
              <span style={{ fontWeight: 400, marginBottom: 0 }}>
                I have read the borrowing rules and accept the £2 per day late fee.
                {errors.agree ? <span className="error">{errors.agree}</span> : null}
              </span>
            </label>

            <button className="btn block" type="submit">Apply for membership</button>
            <p style={{ color: "var(--ink-soft)", fontSize: "0.875rem", marginTop: 12, marginBottom: 0 }}>
              Applications are checked at the desk. Bring proof of address when you first collect.
            </p>
          </form>
        </div>
      </section>
    </Layout>
  );
}

createRoot(document.getElementById("root")!).render(<Join />);
