import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Field, Layout } from "../components/Layout";
import "../styles.css";

/** Sign-in, as approved. Inert: there is no session to issue, and no credential to check it against. */
function Login() {
  const [error, setError] = useState<string | null>(null);

  return (
    <Layout current="/login.html">
      <section className="section" style={{ paddingTop: 64 }}>
        <div className="shell form-narrow">
          <h1>Sign in</h1>
          <p className="lede">To see and change your appointments.</p>

          <form
            id="login"
            noValidate
            style={{ marginTop: 32 }}
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const email = String(data.get("email") ?? "").trim();
              const password = String(data.get("password") ?? "");
              // One message covering both fields, deliberately: which of the two was wrong is not the visitor's
              // business, and saying so tells anyone guessing which addresses are registered here.
              setError(email && password ? null : "Enter your email address and password.");
            }}
          >
            {error ? <div className="notice problem">{error}</div> : null}
            <Field label="Email">
              <input name="email" type="email" autoComplete="email" required />
            </Field>
            <Field label="Password">
              <input name="password" type="password" autoComplete="current-password" required />
            </Field>
            <button className="btn" type="submit" style={{ width: "100%" }}>Sign in</button>
          </form>

          <p style={{ marginTop: 20, color: "var(--ink-soft)" }}>
            No account yet? <a href="/register.html">Create one</a>.
          </p>
        </div>
      </section>
    </Layout>
  );
}

createRoot(document.getElementById("root")!).render(<Login />);
