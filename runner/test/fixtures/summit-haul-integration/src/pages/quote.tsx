import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Layout } from "../components/Layout";
import "../styles.css";

const LOADS = ["Quarter truck — $95", "Half truck — $210", "Three-quarter truck — $340", "Full truck — $480", "Not sure yet"];

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; message: string }
  | { kind: "failed"; message: string; fields?: Record<string, string> };

/**
 * The quote request form — the SAME form, now connected.
 *
 * Nothing about the approved design is touched: identical markup, classes and field order, and at rest the page
 * renders exactly what it rendered before. The only additions appear AFTER a person submits, which is the one
 * thing the integration manifest declared would change.
 *
 * The failure branch is not decorative. If the server cannot store the request, the visitor is told so and given
 * the phone number. A form that always says "thank you" loses the lead silently.
 */
function Quote() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status.kind === "sending") return;
    setStatus({ kind: "sending" });

    // Captured BEFORE the first await. React sets `currentTarget` to null once the handler returns, and this
    // handler is async, so touching `e.currentTarget` after the fetch throws — which the catch below would then
    // report to the visitor as "we could not reach the server" on a request that had in fact succeeded.
    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());

    try {
      const res = await fetch("/api/quote-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string; fields?: Record<string, string> };

      if (res.ok) {
        setStatus({ kind: "sent", message: body.message ?? "Thank you — we have your request." });
        form.reset();
        return;
      }
      setStatus({
        kind: "failed",
        message: body.message ?? "We could not send that. Please call (517) 555-0123.",
        fields: body.fields,
      });
    } catch {
      // The request never reached the server at all.
      setStatus({ kind: "failed", message: "We could not reach the server. Please call (517) 555-0123 and we will take your details." });
    }
  }

  const fieldError = (name: string) => (status.kind === "failed" ? status.fields?.[name] : undefined);
  const busy = status.kind === "sending";

  return (
    <Layout current="/quote.html">
      <section className="hero" style={{ paddingTop: 72, paddingBottom: 72 }}>
        <div className="shell" style={{ gridTemplateColumns: "1fr" }}>
          <div>
            <p className="eyebrow">Free quote</p>
            <h1>Tell us what needs to go</h1>
            <p className="lede">Most quotes come back the same working day. No visit, no obligation.</p>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="shell split">
          <form className="quote-form" id="quote-request" noValidate onSubmit={submit}>
            <div className="field-row">
              <div className="field">
                <label htmlFor="q-name">Your name</label>
                <input id="q-name" name="name" type="text" autoComplete="name" required />
                {fieldError("name") ? <span className="hint" role="alert">{fieldError("name")}</span> : null}
              </div>
              <div className="field">
                <label htmlFor="q-phone">Phone</label>
                <input id="q-phone" name="phone" type="tel" autoComplete="tel" required />
                {fieldError("phone") ? <span className="hint" role="alert">{fieldError("phone")}</span> : null}
              </div>
            </div>

            <div className="field">
              <label htmlFor="q-email">Email</label>
              <input id="q-email" name="email" type="email" autoComplete="email" required />
              <span className="hint">{fieldError("email") ?? "We send the quote here, and nothing else."}</span>
            </div>

            <div className="field-row">
              <div className="field">
                <label htmlFor="q-postcode">Pickup ZIP code</label>
                <input id="q-postcode" name="postcode" type="text" inputMode="numeric" maxLength={5} required />
                {fieldError("postcode") ? <span className="hint" role="alert">{fieldError("postcode")}</span> : null}
              </div>
              <div className="field">
                <label htmlFor="q-load">Rough load size</label>
                <select id="q-load" name="load_size" required defaultValue="">
                  <option value="" disabled>Choose a size</option>
                  {LOADS.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
                {fieldError("load_size") ? <span className="hint" role="alert">{fieldError("load_size")}</span> : null}
              </div>
            </div>

            <div className="field">
              <label htmlFor="q-details">What are we taking?</label>
              <textarea id="q-details" name="details" placeholder="Two sofas, a dryer and about ten boxes in the garage." />
            </div>

            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? "Sending…" : "Request my quote"}
            </button>

            {status.kind === "sent"
              ? <p className="form-status form-status-ok" role="status">{status.message}</p>
              : null}
            {status.kind === "failed"
              ? <p className="form-status form-status-bad" role="alert">{status.message}</p>
              : null}
          </form>

          <aside>
            <h3>Straight answers</h3>
            <p style={{ color: "var(--muted)" }}>
              Quotes are fixed, not estimates. If the load turns out smaller on the day, you pay the smaller
              number.
            </p>
            <h3 style={{ marginTop: 32 }}>Rather talk?</h3>
            <p style={{ color: "var(--muted)" }}>
              Call <a href="tel:+15175550123">(517) 555-0123</a> between 7am and 7pm, Monday to Saturday.
            </p>
            <h3 style={{ marginTop: 32 }}>Service area</h3>
            <p style={{ color: "var(--muted)" }}>
              Lansing, East Lansing, Okemos, Holt, Grand Ledge, DeWitt and Charlotte.
            </p>
          </aside>
        </div>
      </section>
    </Layout>
  );
}

createRoot(document.getElementById("root")!).render(<Quote />);
