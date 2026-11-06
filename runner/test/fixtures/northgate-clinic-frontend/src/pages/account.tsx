import { createRoot } from "react-dom/client";
import { Layout } from "../components/Layout";
import "../styles.css";

/**
 * The patient's own appointments, as approved.
 *
 * As supplied this page shows its empty state, because there is no session and no data: a frontend cannot know who
 * is looking at it. Every row, column and control is designed; what is missing is a backend that returns THIS
 * patient's appointments and nobody else's.
 *
 * That last part is the operation worth getting right, and the manifest says so explicitly: a patient asking for
 * someone else's appointment must be refused, not merely un-linked in the interface. Hiding a row is not
 * authorisation.
 */
function Account() {
  // Deliberately empty and deliberately not faked. Placeholder rows here would be read by the import's probe as a
  // table that already works, and the operation that fills it would never be asked for.
  const appointments: { id: string; when: string; treatment: string; status: "requested" | "confirmed" | "cancelled" }[] = [];

  return (
    <Layout current="/account.html">
      <section className="section" style={{ paddingTop: 56 }}>
        <div className="shell">
          <div style={{ display: "flex", alignItems: "flex-end", gap: 20, flexWrap: "wrap", marginBottom: 28 }}>
            <div style={{ flex: "1 1 340px" }}>
              <p className="eyebrow">Your account</p>
              <h1 style={{ marginBottom: 6 }}>Your appointments</h1>
              <p className="lede" style={{ marginBottom: 0 }}>Everything booked, past and upcoming.</p>
            </div>
            <a className="btn" href="/book.html">Book another</a>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>Upcoming</h2>
            </div>
            {appointments.length === 0 ? (
              <div className="empty">
                <p style={{ marginBottom: 6, fontWeight: 550, color: "var(--ink)" }}>Nothing booked yet</p>
                <p style={{ margin: 0 }}>
                  Your appointments appear here once you are signed in. <a href="/book.html">Book one</a>.
                </p>
              </div>
            ) : (
              <div className="scroller">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Treatment</th>
                      <th scope="col">Status</th>
                      <th scope="col"><span className="visually-hidden">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {appointments.map((a) => (
                      <tr key={a.id}>
                        <td style={{ fontWeight: 550 }}>{a.when}</td>
                        <td>{a.treatment}</td>
                        <td><span className={`pill ${a.status}`}>{a.status}</span></td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          <button className="btn ghost small" type="button">Reschedule</button>{" "}
                          <button className="btn danger small" type="button">Cancel</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="grid-2" style={{ marginTop: 28 }}>
            <div className="card">
              <h3>Your details</h3>
              <p style={{ color: "var(--ink-soft)" }}>
                Name, email, phone and insurance plan. Kept here so you do not have to repeat them at the desk.
              </p>
              <button className="btn ghost small" type="button">Edit details</button>
            </div>
            <div className="card">
              <h3>Cancellation policy</h3>
              <p style={{ color: "var(--ink-soft)", marginBottom: 0 }}>
                Cancel at least 24 hours before your appointment and there is no charge. Later than that, or a missed
                appointment, is charged at $45.
              </p>
            </div>
          </div>
        </div>
      </section>
    </Layout>
  );
}

createRoot(document.getElementById("root")!).render(<Account />);
