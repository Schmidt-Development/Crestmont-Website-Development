import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Layout } from "../components/Layout";
import "../styles.css";

const LOADS = ["Quarter truck — $95", "Half truck — $210", "Three-quarter truck — $340", "Full truck — $480", "Not sure yet"];

/**
 * The quote request form, as the Founder approved it.
 *
 * It has every field, every label and every style it will ever have — but submitting it does nothing yet. That is
 * the point of the design-locked architecture: the appearance is finished, and the only thing missing is a
 * backend. The import's interaction inventory should mark this form as needing one.
 */
function Quote() {
  const [sent, setSent] = useState(false);

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
          <form className="quote-form" id="quote-request" noValidate onSubmit={(e) => { e.preventDefault(); setSent(false); }}>
            <div className="field-row">
              <div className="field">
                <label htmlFor="q-name">Your name</label>
                <input id="q-name" name="name" type="text" autoComplete="name" required />
              </div>
              <div className="field">
                <label htmlFor="q-phone">Phone</label>
                <input id="q-phone" name="phone" type="tel" autoComplete="tel" required />
              </div>
            </div>

            <div className="field">
              <label htmlFor="q-email">Email</label>
              <input id="q-email" name="email" type="email" autoComplete="email" required />
              <span className="hint">We send the quote here, and nothing else.</span>
            </div>

            <div className="field-row">
              <div className="field">
                <label htmlFor="q-postcode">Pickup ZIP code</label>
                <input id="q-postcode" name="postcode" type="text" inputMode="numeric" maxLength={5} required />
              </div>
              <div className="field">
                <label htmlFor="q-load">Rough load size</label>
                <select id="q-load" name="load_size" required defaultValue="">
                  <option value="" disabled>Choose a size</option>
                  {LOADS.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
            </div>

            <div className="field">
              <label htmlFor="q-details">What are we taking?</label>
              <textarea id="q-details" name="details" placeholder="Two sofas, a dryer and about ten boxes in the garage." />
            </div>

            <button className="btn btn-primary" type="submit">Request my quote</button>

            {sent ? <p className="form-status form-status-ok" role="status">Thank you — we will be in touch.</p> : null}
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
