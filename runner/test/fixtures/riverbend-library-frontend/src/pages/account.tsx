import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Layout } from "../components/Layout";
import "../styles.css";

type Status = "reserved" | "out" | "returned" | "overdue";
interface Reservation { id: string; item: string; from: string; to: string; status: Status }
interface Message { id: string; from: "member" | "staff"; at: string; body: string }

/**
 * A member's own reservations, and their message thread with the desk.
 *
 * Two different ownership problems live on this page, and the manifest treats them separately:
 *   · a reservation belongs to one member, and only that member may see or cancel it;
 *   · a message thread has two sides, and a member must see the staff replies on their OWN thread and no one
 *     else's. This is the customer-to-admin interaction, and it is the one most easily got wrong by filtering in
 *     the browser instead of on the server.
 *
 * The tab switching and the composer's validation are real. Everything they would act on is missing.
 */
function Account() {
  const [tab, setTab] = useState<"reservations" | "messages">("reservations");
  const [reservations] = useState<Reservation[]>([]);
  const [thread] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <Layout current="/account.html">
      <section className="section">
        <div className="shell">
          <p className="eyebrow">Your membership</p>
          <h1 style={{ marginBottom: 6 }}>Your reservations</h1>
          <p className="lede">What you have out, what is booked, and anything you have asked the desk.</p>

          <div className="tabs" role="tablist" aria-label="Your account" style={{ marginTop: 28 }}>
            <button role="tab" aria-selected={tab === "reservations"} onClick={() => setTab("reservations")}>Reservations</button>
            <button role="tab" aria-selected={tab === "messages"} onClick={() => setTab("messages")}>Messages</button>
          </div>

          {tab === "reservations" ? (
            <div className="panel">
              <div className="panel-head">
                <h2>Current and past</h2>
                <a className="btn small" href="/index.html" style={{ marginLeft: "auto" }}>Browse the catalogue</a>
              </div>
              {reservations.length === 0 ? (
                <div className="empty">
                  <p style={{ marginBottom: 6, fontWeight: 650, color: "var(--ink)" }}>Nothing reserved yet</p>
                  <p style={{ margin: 0 }}>Your reservations appear here once you are signed in.</p>
                </div>
              ) : (
                <div className="scroller">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Item</th><th scope="col">Collect</th><th scope="col">Return</th>
                        <th scope="col">Status</th><th scope="col"><span className="visually-hidden">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {reservations.map((r) => (
                        <tr key={r.id}>
                          <td style={{ fontWeight: 600 }}>{r.item}</td>
                          <td>{r.from}</td>
                          <td>{r.to}</td>
                          <td><span className={`tag ${r.status === "returned" ? "in" : r.status === "overdue" ? "out" : "soon"}`}>{r.status}</span></td>
                          <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                            <button className="btn ghost small" type="button">Cancel</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <div className="panel">
              <div className="panel-head"><h2>Messages with the desk</h2></div>
              {thread.length === 0 ? (
                <div className="empty">
                  <p style={{ marginBottom: 6, fontWeight: 650, color: "var(--ink)" }}>No messages yet</p>
                  <p style={{ margin: 0 }}>Ask about an item, a loan length or a repair.</p>
                </div>
              ) : (
                <ul className="thread">
                  {thread.map((m) => (
                    <li className={m.from === "member" ? "msg mine" : "msg"} key={m.id}>
                      <p className="who">{m.from === "member" ? "You" : "The desk"} · {m.at}</p>
                      <p>{m.body}</p>
                    </li>
                  ))}
                </ul>
              )}
              <form
                id="message-compose"
                noValidate
                style={{ padding: "0 20px 20px", borderTop: "1px solid var(--line)" }}
                onSubmit={(e) => {
                  e.preventDefault();
                  setError(draft.trim().length < 3 ? "Write a message first." : null);
                  // Nothing is sent: there is no thread to send it to.
                }}
              >
                {error ? <div className="notice problem" style={{ marginTop: 16 }}>{error}</div> : null}
                <label className="field" style={{ marginTop: 16 }}>
                  <span>Your message</span>
                  <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Is the tile cutter back yet?" />
                </label>
                <button className="btn" type="submit">Send to the desk</button>
              </form>
            </div>
          )}
        </div>
      </section>
    </Layout>
  );
}

createRoot(document.getElementById("root")!).render(<Account />);
