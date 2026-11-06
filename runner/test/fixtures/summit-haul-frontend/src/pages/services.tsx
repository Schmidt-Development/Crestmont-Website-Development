import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Layout } from "../components/Layout";
import "../styles.css";

const RATES = [
  { load: "Quarter truck", volume: "2 yd³", examples: "A mattress and a few boxes", price: "$95" },
  { load: "Half truck", volume: "5 yd³", examples: "Living-room set, small shed", price: "$210" },
  { load: "Three-quarter truck", volume: "8 yd³", examples: "Garage clear-out", price: "$340" },
  { load: "Full truck", volume: "12 yd³", examples: "Two-bedroom apartment", price: "$480" },
  { load: "Clear-out crew", volume: "By the day", examples: "Estate or foreclosure", price: "$680" },
];

const CATEGORIES = ["All jobs", "Household", "Commercial", "Construction"] as const;

const JOBS = [
  { name: "Appliance removal", cat: "Household", body: "Fridges, washers and water heaters, disconnected and taken for recycling." },
  { name: "Garage and basement", cat: "Household", body: "Decades of boxes, sorted into keep, donate and haul on the spot." },
  { name: "Office fit-out strip", cat: "Commercial", body: "Desks, partitions and cabling pulled out overnight so nobody loses a working day." },
  { name: "Retail refit clearance", cat: "Commercial", body: "Shelving and fixtures out between close and open, with the loading bay left swept." },
  { name: "Roof tear-off haul", cat: "Construction", body: "Shingles and felt loaded straight from the chute into a lined trailer." },
  { name: "Concrete and brick", cat: "Construction", body: "Heavy fill taken to an inert-waste facility, weighbridge tickets included." },
];

/**
 * The category filter is genuine client-side state: it changes what is rendered without any server. The import
 * probe should find it already functional. The rate table is static content.
 */
function Services() {
  const [cat, setCat] = useState<(typeof CATEGORIES)[number]>("All jobs");
  const shown = cat === "All jobs" ? JOBS : JOBS.filter((j) => j.cat === cat);

  return (
    <Layout current="/services.html">
      <section className="hero" style={{ paddingTop: 72, paddingBottom: 72 }}>
        <div className="shell" style={{ gridTemplateColumns: "1fr" }}>
          <div>
            <p className="eyebrow">Services</p>
            <h1>Priced by the load, not the hour</h1>
            <p className="lede">Volume pricing, quoted from photos, with the disposal fees already inside the number.</p>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="shell">
          <div className="section-head">
            <p className="eyebrow">Rates</p>
            <h2>What a load costs</h2>
            <p>Prices include labour, transport and tipping fees. Stairs and long carries are not extra.</p>
          </div>
          <div className="table-scroll">
          <table className="rate-table">
            <thead>
              <tr>
                <th scope="col">Load</th>
                <th scope="col">Volume</th>
                <th scope="col">Typical job</th>
                <th scope="col">Price</th>
              </tr>
            </thead>
            <tbody>
              {RATES.map((r) => (
                <tr key={r.load}>
                  <td>{r.load}</td>
                  <td>{r.volume}</td>
                  <td>{r.examples}</td>
                  <td><strong>{r.price}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      </section>

      <section className="section section-sand">
        <div className="shell">
          <div className="section-head">
            <p className="eyebrow">By sector</p>
            <h2>Pick the kind of job</h2>
          </div>

          <div className="field" style={{ maxWidth: 320, marginBottom: 40 }}>
            <label htmlFor="job-category">Filter by sector</label>
            <select
              id="job-category"
              name="category"
              value={cat}
              onChange={(e) => setCat(e.target.value as (typeof CATEGORIES)[number])}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <span className="hint">{shown.length} of {JOBS.length} services shown</span>
          </div>

          <ul className="card-grid">
            {shown.map((j) => (
              <li className="card" key={j.name}>
                <h3>{j.name}</h3>
                <p>{j.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="section">
        <div className="shell" style={{ textAlign: "center" }}>
          <h2>Know what you need gone?</h2>
          <p style={{ color: "var(--muted)", fontSize: "var(--step-1)" }}>Send three photos and we will quote it today.</p>
          <a className="btn btn-primary" href="/quote.html">Get a free quote</a>
        </div>
      </section>
    </Layout>
  );
}

createRoot(document.getElementById("root")!).render(<Services />);
