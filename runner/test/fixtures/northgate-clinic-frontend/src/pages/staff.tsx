import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Layout } from "../components/Layout";
import "../styles.css";

type Status = "requested" | "confirmed" | "cancelled";
interface Appointment {
  id: string;
  patient: string;
  when: string;
  treatment: string;
  status: Status;
}

/**
 * The practice schedule, as approved: the staff view of everyone's appointments.
 *
 * This is the page that makes the design-locked architecture interesting, because the thing that makes it correct is
 * invisible. It looks like a table with a search box. What matters is that only staff may see it at all, and the
 * frontend CANNOT enforce that — a page served to a browser is served to whoever asks. The manifest therefore asks
 * for the check on the server, and for this page's data endpoint to refuse a patient outright rather than returning
 * an empty list.
 *
 * The search and status filter below are real: they filter whatever list they are given, in the browser. They are
 * not what is missing. What is missing is the list.
 */
function Staff() {
  // Empty and not faked, for the same reason as account.tsx: invented rows would read as a working table.
  const [all] = useState<Appointment[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status | "all">("all");

  // Real client-side filtering of whatever arrives. With nothing to filter it simply shows the empty state.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((a) => {
      if (status !== "all" && a.status !== status) return false;
      if (!q) return true;
      return `${a.patient} ${a.treatment}`.toLowerCase().includes(q);
    });
  }, [all, query, status]);

  const counts = useMemo(() => ({
    requested: all.filter((a) => a.status === "requested").length,
    confirmed: all.filter((a) => a.status === "confirmed").length,
  }), [all]);

  return (
    <Layout current="/staff.html">
      <section className="section" style={{ paddingTop: 56 }}>
        <div className="shell">
          <p className="eyebrow">Practice</p>
          <h1 style={{ marginBottom: 6 }}>Schedule</h1>
          <p className="lede">Every appointment, and the ones still waiting to be confirmed.</p>

          <div className="grid-3" style={{ margin: "28px 0" }}>
            <div className="card">
              <h3 style={{ color: "var(--warn)" }}>Waiting to confirm</h3>
              <p style={{ fontSize: "var(--step-3)", fontWeight: 650, margin: 0 }}>{counts.requested}</p>
            </div>
            <div className="card">
              <h3 style={{ color: "var(--ok)" }}>Confirmed</h3>
              <p style={{ fontSize: "var(--step-3)", fontWeight: 650, margin: 0 }}>{counts.confirmed}</p>
            </div>
            <div className="card">
              <h3>Today</h3>
              <p style={{ color: "var(--ink-soft)", margin: 0 }}>
                {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
              </p>
            </div>
          </div>

          <div className="toolbar">
            <label className="visually-hidden" htmlFor="staff-search">Search patients and treatments</label>
            <input
              id="staff-search"
              type="search"
              placeholder="Search patient or treatment"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <label className="visually-hidden" htmlFor="staff-status">Filter by status</label>
            <select id="staff-status" value={status} onChange={(e) => setStatus(e.target.value as Status | "all")}>
              <option value="all">All statuses</option>
              <option value="requested">Requested</option>
              <option value="confirmed">Confirmed</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <span className="spacer" />
            <button className="btn ghost small" type="button">Export day sheet</button>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>Appointments</h2>
              <span style={{ marginLeft: "auto", color: "var(--ink-soft)" }}>
                {shown.length} of {all.length}
              </span>
            </div>
            {shown.length === 0 ? (
              <div className="empty">
                <p style={{ marginBottom: 6, fontWeight: 550, color: "var(--ink)" }}>No appointments to show</p>
                <p style={{ margin: 0 }}>
                  {all.length === 0
                    ? "The schedule is empty until it can be loaded."
                    : "Nothing matches that search."}
                </p>
              </div>
            ) : (
              <div className="scroller">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Patient</th>
                      <th scope="col">When</th>
                      <th scope="col">Treatment</th>
                      <th scope="col">Status</th>
                      <th scope="col"><span className="visually-hidden">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((a) => (
                      <tr key={a.id}>
                        <td style={{ fontWeight: 550 }}>{a.patient}</td>
                        <td>{a.when}</td>
                        <td>{a.treatment}</td>
                        <td><span className={`pill ${a.status}`}>{a.status}</span></td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          <button className="btn small" type="button">Confirm</button>{" "}
                          <button className="btn danger small" type="button">Cancel</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </section>
    </Layout>
  );
}

createRoot(document.getElementById("root")!).render(<Staff />);
