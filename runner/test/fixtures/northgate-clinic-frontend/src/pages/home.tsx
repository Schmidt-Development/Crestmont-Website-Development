import { createRoot } from "react-dom/client";
import { Layout } from "../components/Layout";
import "../styles.css";

const TREATMENTS = [
  { name: "Cleanings & check-ups", body: "A hygienist appointment every six months, with x-rays once a year." },
  { name: "Fillings & crowns", body: "Tooth-coloured fillings, and same-week crowns milled in the practice." },
  { name: "Whitening", body: "Take-home trays fitted from your own impressions, or one in-chair session." },
];

const REASONS = [
  { k: "Evenings", v: "Open until 8pm on Tuesdays and Thursdays." },
  { k: "Most insurance", v: "We bill Delta, MetLife, Cigna and Aetna directly." },
  { k: "Emergencies", v: "Call before 10am and we will see you the same day." },
];

function Home() {
  return (
    <Layout current="/index.html">
      <section className="hero">
        <div className="shell">
          <div>
            <p className="eyebrow">Ann Arbor · since 2004</p>
            <h1>Dentistry that fits around your week</h1>
            <p className="lede">
              Family and cosmetic dentistry on Northgate Road. Book online, see the same dentist each visit, and get
              an honest answer about what actually needs doing.
            </p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
              <a className="btn" href="/book.html">Book an appointment</a>
              <a className="btn ghost" href="/services.html">See treatments</a>
            </div>
          </div>
          <div className="card">
            <h3>New patients</h3>
            <p style={{ color: "var(--ink-soft)" }}>
              Your first visit is a 45-minute examination with x-rays and a written treatment plan. No obligation to
              book anything further.
            </p>
            <p style={{ fontSize: "var(--step-2)", fontWeight: 650, margin: "16px 0 4px" }}>$89</p>
            <p style={{ color: "var(--ink-soft)", margin: 0 }}>or covered in full by most plans</p>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="shell">
          <h2>What we do</h2>
          <p className="lede">Everything a family needs in one practice, and nothing we would not do ourselves.</p>
          <div className="grid-3" style={{ marginTop: 36 }}>
            {TREATMENTS.map((t) => (
              <div className="card" key={t.name}>
                <h3>{t.name}</h3>
                <p style={{ color: "var(--ink-soft)", margin: 0 }}>{t.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section tight" style={{ background: "var(--card)", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
        <div className="shell grid-3">
          {REASONS.map((r) => (
            <div key={r.k}>
              <h3 style={{ color: "var(--teal-dark)" }}>{r.k}</h3>
              <p style={{ color: "var(--ink-soft)", margin: 0 }}>{r.v}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="shell card" style={{ display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 320px" }}>
            <h2 style={{ marginBottom: 8 }}>Ready when you are</h2>
            <p style={{ color: "var(--ink-soft)", margin: 0 }}>Most requests are confirmed the same working day.</p>
          </div>
          <a className="btn" href="/book.html">Book an appointment</a>
        </div>
      </section>
    </Layout>
  );
}

createRoot(document.getElementById("root")!).render(<Home />);
