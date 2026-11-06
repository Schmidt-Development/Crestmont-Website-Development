import { createRoot } from "react-dom/client";
import { Layout } from "../components/Layout";
import "../styles.css";

function TruckArt() {
  return (
    <svg viewBox="0 0 520 320" role="img" aria-label="A Summit Haul truck beside a loaded trailer">
      <rect x="0" y="236" width="520" height="8" fill="#D98324" />
      <path d="M40 236 V128 h150 v108 Z" fill="#E8DCC8" />
      <path d="M190 236 V160 h58 l40 44 v32 Z" fill="#D98324" />
      <rect x="202" y="170" width="44" height="30" fill="#15291D" />
      <circle cx="92" cy="246" r="26" fill="#15291D" />
      <circle cx="92" cy="246" r="10" fill="#E8DCC8" />
      <circle cx="250" cy="246" r="26" fill="#15291D" />
      <circle cx="250" cy="246" r="10" fill="#E8DCC8" />
      <rect x="56" y="146" width="118" height="14" fill="#1F3D2B" />
      <rect x="56" y="172" width="80" height="10" fill="#1F3D2B" opacity="0.5" />
      <path d="M320 236 V180 h170 v56 Z" fill="#1F3D2B" />
      <path d="M332 180 l24 -34 h50 l18 34 Z" fill="#D98324" />
      <path d="M408 180 l20 -26 h40 l14 26 Z" fill="#E8DCC8" />
      <circle cx="368" cy="246" r="20" fill="#15291D" />
      <circle cx="452" cy="246" r="20" fill="#15291D" />
    </svg>
  );
}

const SERVICES = [
  { title: "Single item pickup", body: "One couch, one fridge, one hot tub. We quote it in minutes and take it the same week.", price: "from $95", icon: "#D98324" },
  { title: "Full property clear-out", body: "Estates, evictions and foreclosures. Crew of three, dumpster on site, photos when we are done.", price: "from $680", icon: "#1F3D2B" },
  { title: "Construction debris", body: "Shingles, drywall, lumber and concrete, sorted and taken to the right facility with the paperwork.", price: "from $340", icon: "#15291D" },
];

function Home() {
  return (
    <Layout current="/index.html">
      <section className="hero">
        <div className="shell">
          <div>
            <p className="eyebrow">Mid-Michigan · Licensed &amp; insured</p>
            <h1>We haul what you are done with</h1>
            <p className="lede">
              Same-week junk removal for homes, landlords and job sites. You point, we carry, you get the
              before-and-after photos.
            </p>
            <div className="hero-actions">
              <a className="btn btn-primary" href="/quote.html">Get a free quote</a>
              <a className="btn btn-ghost" href="tel:+15175550123">Call (517) 555-0123</a>
            </div>
          </div>
          <div className="hero-art"><TruckArt /></div>
        </div>
      </section>

      <section className="section">
        <div className="shell">
          <div className="section-head">
            <p className="eyebrow">What we take</p>
            <h2>Three ways we work</h2>
            <p>Every job is quoted on volume, not on an hourly guess. The price you are told is the price you pay.</p>
          </div>
          <ul className="card-grid">
            {SERVICES.map((s) => (
              <li className="card" key={s.title}>
                <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
                  <rect width="44" height="44" rx="3" fill={s.icon} opacity="0.12" />
                  <path d="M11 30 L22 13 L33 30 Z" fill={s.icon} />
                </svg>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
                <span className="price">{s.price}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="section section-sand">
        <div className="shell">
          <div className="section-head">
            <p className="eyebrow">How it goes</p>
            <h2>Booked in three steps</h2>
          </div>
          <div className="steps">
            <div className="step">
              <h3>Send photos</h3>
              <p>Snap what needs to go. We quote from pictures, so nobody waits around for an estimate visit.</p>
            </div>
            <div className="step">
              <h3>Pick a window</h3>
              <p>Morning or afternoon, Monday to Saturday. We text when the truck is thirty minutes out.</p>
            </div>
            <div className="step">
              <h3>We clear it</h3>
              <p>We sweep up, take the photos, and you get an itemised receipt with the disposal certificates.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="shell faq">
          <div className="section-head">
            <p className="eyebrow">Questions</p>
            <h2>Before you book</h2>
          </div>
          <details>
            <summary>Do I need to be there?</summary>
            <p>No. Leave it on the kerb or unlock the garage and we will send photos when the job is finished.</p>
          </details>
          <details>
            <summary>What will you not take?</summary>
            <p>Paint, solvents, asbestos and anything still hooked up to gas. We will tell you who can.</p>
          </details>
          <details>
            <summary>How fast can you come?</summary>
            <p>Most jobs inside four working days. Clear-outs with a dumpster usually need a week&rsquo;s notice.</p>
          </details>
        </div>
      </section>
    </Layout>
  );
}

createRoot(document.getElementById("root")!).render(<Home />);
