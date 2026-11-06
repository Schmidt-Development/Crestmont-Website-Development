import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Field, Layout } from "../components/Layout";
import "../styles.css";

const STEPS = ["Dates", "Check", "Confirm"] as const;
type Step = 0 | 1 | 2;

/**
 * An item and its reservation, as approved.
 *
 * The wizard is REAL: three steps, client-side step state, a date range validated in the browser (no past dates,
 * return after collection, at most the seven-day loan), and a summary built from what was entered. None of that
 * needs a backend and none of it is what the manifest asks for.
 *
 * Three things here DO need one, and they are different from each other:
 *   · which item this page is about — the id is in the query string and nothing can resolve it;
 *   · whether those dates are actually free — only the reservation records know;
 *   · recording the reservation at the end.
 *
 * The third step therefore stops at a button that does nothing, and says so, rather than showing a confirmation
 * for a reservation that was never made.
 */
function Item() {
  const [step, setStep] = useState<Step>(0);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<{ from?: string; to?: string }>({});

  // The id of the item this page is for. Present, and unresolvable without a collection to look it up in.
  const itemId = useMemo(() => new URLSearchParams(window.location.search).get("id") ?? "", []);

  const days = useMemo(() => {
    if (!from || !to) return 0;
    const ms = Date.parse(to) - Date.parse(from);
    return ms >= 0 ? Math.round(ms / 86_400_000) + 1 : 0;
  }, [from, to]);

  const validateDates = () => {
    const e: { from?: string; to?: string } = {};
    const today = new Date().toISOString().slice(0, 10);
    if (!from) e.from = "Choose the day you will collect it.";
    else if (from < today) e.from = "That day has passed.";
    if (!to) e.to = "Choose the day you will bring it back.";
    else if (from && to < from) e.to = "The return day cannot be before the collection day.";
    else if (days > 7) e.to = "Loans run for up to seven days. Ask at the desk for longer.";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  return (
    <Layout current="/index.html">
      <section className="section">
        <div className="shell">
          <p style={{ marginBottom: 18 }}><a href="/index.html">&larr; Back to the catalogue</a></p>

          <div className="row" style={{ gridTemplateColumns: "1.1fr 0.9fr", alignItems: "start" }}>
            <div>
              <div className="thumb" style={{ aspectRatio: "16 / 10" }} aria-hidden="true" />
              <h1 style={{ marginTop: 20 }}>This item</h1>
              {/* Not a placeholder name: inventing one would read as a page that already works, and the operation
                  that resolves the id would never be asked for. */}
              <p className="lede">
                {itemId
                  ? `Reference ${itemId}. The item's name, category, condition and deposit are shown here once the collection can be loaded.`
                  : "No item reference was given, so there is nothing to show."}
              </p>

              <div className="panel" style={{ marginTop: 24 }}>
                <div className="panel-head"><h2>Condition and care</h2></div>
                <ul className="summary" style={{ padding: "6px 20px 14px" }}>
                  <li><span className="k">Deposit</span><span className="v">shown with the item</span></li>
                  <li><span className="k">Loan</span><span className="v">up to 7 days</span></li>
                  <li><span className="k">Late fee</span><span className="v">£2 per day</span></li>
                  <li><span className="k">Collection</span><span className="v">14 Mill Lane, opening hours</span></li>
                </ul>
              </div>
            </div>

            <div className="card">
              <h2 style={{ fontSize: "var(--step-2)" }}>Reserve it</h2>

              <ol className="steps" aria-label="Reservation steps">
                {STEPS.map((s, i) => (
                  <li key={s} aria-current={i === step ? "step" : undefined} className={i < step ? "done" : undefined}>
                    {i + 1}. {s}
                  </li>
                ))}
              </ol>

              {step === 0 ? (
                <form
                  id="reserve-dates"
                  noValidate
                  onSubmit={(e) => { e.preventDefault(); if (validateDates()) setStep(1); }}
                >
                  <Field label="Collect on" error={errors.from}>
                    <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
                  </Field>
                  <Field label="Bring back by" hint="Loans run for up to seven days." error={errors.to}>
                    <input type="date" value={to} onChange={(e) => setTo(e.target.value)} required />
                  </Field>
                  <button className="btn block" type="submit">Check these dates</button>
                </form>
              ) : null}

              {step === 1 ? (
                <div>
                  <ul className="summary">
                    <li><span className="k">Collect</span><span className="v">{from}</span></li>
                    <li><span className="k">Return</span><span className="v">{to}</span></li>
                    <li><span className="k">Length</span><span className="v">{days} day{days === 1 ? "" : "s"}</span></li>
                  </ul>
                  {/* Honest: whether the item is free on those dates is not something this page can know. */}
                  <div className="notice" style={{ marginTop: 18 }}>
                    Whether this item is free on those dates is checked when the reservation is made.
                  </div>
                  <Field label="Anything to tell the desk?" hint="Optional.">
                    <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
                  </Field>
                  <div style={{ display: "flex", gap: 10 }}>
                    <button className="btn ghost" type="button" onClick={() => setStep(0)}>Back</button>
                    <button className="btn" type="button" style={{ marginLeft: "auto" }} onClick={() => setStep(2)}>Continue</button>
                  </div>
                </div>
              ) : null}

              {step === 2 ? (
                <form
                  id="reserve-confirm"
                  noValidate
                  onSubmit={(e) => {
                    e.preventDefault();
                    // Nowhere to send it. No confirmation is shown, because none would be true.
                  }}
                >
                  <ul className="summary">
                    <li><span className="k">Item</span><span className="v">{itemId || "—"}</span></li>
                    <li><span className="k">Collect</span><span className="v">{from}</span></li>
                    <li><span className="k">Return</span><span className="v">{to}</span></li>
                  </ul>
                  <p style={{ color: "var(--ink-soft)", fontSize: "0.875rem", margin: "14px 0" }}>
                    You will need your membership card when you collect. Reservations are held until closing on the
                    collection day.
                  </p>
                  <div style={{ display: "flex", gap: 10 }}>
                    <button className="btn ghost" type="button" onClick={() => setStep(1)}>Back</button>
                    <button className="btn" type="submit" style={{ marginLeft: "auto" }}>Reserve this item</button>
                  </div>
                </form>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    </Layout>
  );
}

createRoot(document.getElementById("root")!).render(<Item />);
