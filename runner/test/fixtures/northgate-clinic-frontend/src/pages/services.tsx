import { createRoot } from "react-dom/client";
import { Layout } from "../components/Layout";
import "../styles.css";

const GROUPS = [
  {
    group: "Routine care",
    items: [
      { name: "Examination and x-rays", price: "$89", note: "45 minutes. New patients." },
      { name: "Hygienist clean", price: "$110", note: "Every six months." },
      { name: "Child check-up", price: "Free", note: "Under 16 with a parent registered here." },
    ],
  },
  {
    group: "Restorative",
    items: [
      { name: "Tooth-coloured filling", price: "from $180", note: "One visit." },
      { name: "Crown", price: "from $980", note: "Milled in the practice; usually one visit." },
      { name: "Root canal treatment", price: "from $720", note: "Two visits." },
    ],
  },
  {
    group: "Cosmetic",
    items: [
      { name: "Take-home whitening", price: "$340", note: "Trays made from your impressions." },
      { name: "In-chair whitening", price: "$520", note: "One 90-minute session." },
      { name: "Veneer", price: "from $1,150", note: "Per tooth. Consultation first." },
    ],
  },
];

function Services() {
  return (
    <Layout current="/services.html">
      <section className="hero" style={{ paddingTop: 64, paddingBottom: 64 }}>
        <div className="shell" style={{ gridTemplateColumns: "1fr" }}>
          <div>
            <p className="eyebrow">Treatments</p>
            <h1>Prices, written down</h1>
            <p className="lede">
              What things cost before you sit in the chair. Insurance is billed directly where we can, and we will
              tell you what a plan covers before any work starts.
            </p>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="shell">
          {GROUPS.map((g) => (
            <div className="panel" key={g.group} style={{ marginBottom: 28 }}>
              <div className="panel-head"><h2>{g.group}</h2></div>
              <div className="scroller">
                <table>
                  <thead>
                    <tr><th scope="col">Treatment</th><th scope="col">Price</th><th scope="col">Notes</th></tr>
                  </thead>
                  <tbody>
                    {g.items.map((i) => (
                      <tr key={i.name}>
                        <td style={{ fontWeight: 550 }}>{i.name}</td>
                        <td>{i.price}</td>
                        <td style={{ color: "var(--ink-soft)" }}>{i.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          <p style={{ color: "var(--ink-soft)" }}>
            Prices are for private treatment and were last reviewed in January 2026.
          </p>
        </div>
      </section>
    </Layout>
  );
}

createRoot(document.getElementById("root")!).render(<Services />);
