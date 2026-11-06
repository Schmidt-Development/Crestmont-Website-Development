import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Field, Layout } from "../components/Layout";
import "../styles.css";

/** Sign-in, as approved. Inert: no session can be issued and no credential checked. */
function Login() {
  const [error, setError] = useState<string | null>(null);

  return (
    <Layout current="/login.html">
      <section className="section">
        <div className="shell" style={{ maxWidth: 480 }}>
          <h1>Sign in</h1>
          <p className="lede">To see your reservations and message the desk.</p>

          <form
            id="login"
            noValidate
            style={{ marginTop: 28 }}
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const email = String(data.get("email") ?? "").trim();
              const password = String(data.get("password") ?? "");
              // One message for both: which half was wrong is not the visitor's business, and saying so would tell
              // anyone guessing which addresses are members here.
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
            <button className="btn block" type="submit">Sign in</button>
          </form>

          <p style={{ marginTop: 18, color: "var(--ink-soft)" }}>
            Not a member yet? <a href="/join.html">Join the library</a>.
          </p>
        </div>
      </section>
    </Layout>
  );
}

createRoot(document.getElementById("root")!).render(<Login />);
