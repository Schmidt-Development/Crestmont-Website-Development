import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Layout } from "../components/Layout";
import "../styles.css";

interface Queued { id: string; member: string; item: string; from: string; to: string }
interface Stock { id: string; name: string; category: string; out: boolean; condition: string }
interface Enquiry { id: string; member: string; at: string; body: string; answered: boolean }

/**
 * The library desk, as approved: staff-only.
 *
 * The page cannot enforce that. It is served to whoever asks for it, and the navigation link being absent for a
 * member is decoration, not a control. So the manifest asks for the check on the server for each of the three
 * things this page reads, and says explicitly that a member session must be REFUSED rather than handed an empty
 * list — an empty list looks identical to "there is nothing today", and that is how a hole stays hidden.
 *
 * The tab state, the search and the counts are real client-side behaviour over whatever arrives.
 */
function Admin() {
  const [tab, setTab] = useState<"queue" | "stock" | "enquiries">("queue");
  const [queue] = useState<Queued[]>([]);
  const [stock] = useState<Stock[]>([]);
  const [enquiries] = useState<Enquiry[]>([]);
  const [find, setFind] = useState("");

  const stockShown = useMemo(() => {
    const q = find.trim().toLowerCase();
    return q ? stock.filter((s) => `${s.name} ${s.category}`.toLowerCase().includes(q)) : stock;
  }, [stock, find]);

  const unanswered = enquiries.filter((e) => !e.answered).length;

  return (
    <Layout current="/admin.html">
      <section className="section">
        <div className="shell">
          <p className="eyebrow">Staff</p>
          <h1 style={{ marginBottom: 6 }}>Library desk</h1>
          <p className="lede">The queue for today, the collection, and anything a member has asked.</p>

          <div className="row" style={{ gridTemplateColumns: "repeat(3, 1fr)", margin: "26px 0" }}>
            <div className="card"><h3>To hand out</h3><p style={{ fontSize: "var(--step-3)", fontWeight: 650, margin: 0, fontFamily: "var(--serif)" }}>{queue.length}</p></div>
            <div className="card"><h3>Items out</h3><p style={{ fontSize: "var(--step-3)", fontWeight: 650, margin: 0, fontFamily: "var(--serif)" }}>{stock.filter((s) => s.out).length}</p></div>
            <div className="card"><h3>Unanswered</h3><p style={{ fontSize: "var(--step-3)", fontWeight: 650, margin: 0, fontFamily: "var(--serif)" }}>{unanswered}</p></div>
          </div>

          <div className="tabs" role="tablist" aria-label="Desk views">
            <button role="tab" aria-selected={tab === "queue"} onClick={() => setTab("queue")}>Reservation queue</button>
            <button role="tab" aria-selected={tab === "stock"} onClick={() => setTab("stock")}>Collection</button>
            <button role="tab" aria-selected={tab === "enquiries"} onClick={() => setTab("enquiries")}>Enquiries</button>
          </div>

          {tab === "queue" ? (
            <div className="panel">
              <div className="panel-head"><h2>Waiting to be handed out</h2></div>
              {queue.length === 0 ? (
                <div className="empty"><p style={{ margin: 0 }}>The queue is empty until it can be loaded.</p></div>
              ) : (
                <div className="scroller">
                  <table>
                    <thead><tr><th scope="col">Member</th><th scope="col">Item</th><th scope="col">Collect</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr></thead>
                    <tbody>
                      {queue.map((q) => (
                        <tr key={q.id}>
                          <td style={{ fontWeight: 600 }}>{q.member}</td>
                          <td>{q.item}</td>
                          <td>{q.from}</td>
                          <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                            <button className="btn small" type="button">Hand out</button>{" "}
                            <button className="btn ghost small" type="button">Cancel</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : null}

          {tab === "stock" ? (
            <div className="panel">
              <div className="panel-head">
                <h2>Collection</h2>
                <label className="visually-hidden" htmlFor="stock-find">Search the collection</label>
                <input id="stock-find" type="search" placeholder="Find an item" value={find} onChange={(e) => setFind(e.target.value)} style={{ marginLeft: "auto", width: 220 }} />
              </div>
              {stockShown.length === 0 ? (
                <div className="empty"><p style={{ margin: 0 }}>{stock.length === 0 ? "The collection is empty until it can be loaded." : "Nothing matches that search."}</p></div>
              ) : (
                <div className="scroller">
                  <table>
                    <thead><tr><th scope="col">Item</th><th scope="col">Category</th><th scope="col">Condition</th><th scope="col">Where</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr></thead>
                    <tbody>
                      {stockShown.map((s) => (
                        <tr key={s.id}>
                          <td style={{ fontWeight: 600 }}>{s.name}</td>
                          <td>{s.category}</td>
                          <td>{s.condition}</td>
                          <td><span className={`tag ${s.out ? "out" : "in"}`}>{s.out ? "On loan" : "On the shelf"}</span></td>
                          <td style={{ textAlign: "right" }}><button className="btn ghost small" type="button">Edit</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : null}

          {tab === "enquiries" ? (
            <div className="panel">
              <div className="panel-head"><h2>Member enquiries</h2></div>
              {enquiries.length === 0 ? (
                <div className="empty"><p style={{ margin: 0 }}>No enquiries until they can be loaded.</p></div>
              ) : (
                <ul className="thread">
                  {enquiries.map((e) => (
                    <li className="msg" key={e.id}>
                      <p className="who">{e.member} · {e.at}</p>
                      <p>{e.body}</p>
                      <form style={{ marginTop: 10 }} onSubmit={(ev) => ev.preventDefault()}>
                        <label className="visually-hidden" htmlFor={`reply-${e.id}`}>Reply to {e.member}</label>
                        <textarea id={`reply-${e.id}`} placeholder="Reply…" style={{ minHeight: 70 }} />
                        <button className="btn small" type="submit" style={{ marginTop: 8 }}>Send reply</button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      </section>
    </Layout>
  );
}

createRoot(document.getElementById("root")!).render(<Admin />);
