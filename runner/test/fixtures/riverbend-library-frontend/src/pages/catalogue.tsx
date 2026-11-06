import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Layout } from "../components/Layout";
import "../styles.css";

type Availability = "in" | "out" | "soon";
interface Item {
  id: string;
  name: string;
  category: string;
  deposit: number;
  availability: Availability;
  blurb: string;
}

const CATEGORIES = ["Power tools", "Hand tools", "Garden", "Ladders & access", "Decorating", "Measuring"];
const SORTS = [
  { id: "name", label: "Name, A to Z" },
  { id: "deposit-low", label: "Deposit, lowest first" },
  { id: "deposit-high", label: "Deposit, highest first" },
  { id: "availability", label: "Available first" },
] as const;

/**
 * The catalogue, as approved: the richest interactive surface in this artifact.
 *
 * Everything on this page that filters, searches, sorts or counts is REAL and runs in the browser. It operates on
 * whatever list it is given. What it is not given is a list — there is no endpoint — so it renders the approved
 * empty state.
 *
 * That split is the point, and it is what the import's interaction inventory has to get right. A probe that called
 * the search box "needs a backend" would be half wrong: the searching works; the collection is missing. A probe
 * that called it "already functional" would be half wrong the other way. The manifest therefore asks for one
 * operation — serve the collection — and names the filters as the thing that consumes it, rather than asking for
 * seven separate pieces of interactivity that already exist.
 *
 * Nothing here is seeded with placeholder items on purpose. Invented rows would read to the probe as a catalogue
 * that already works, and the one operation that matters would never be asked for.
 */
function Catalogue() {
  const [items] = useState<Item[]>([]);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [availableOnly, setAvailableOnly] = useState(false);
  const [sort, setSort] = useState<(typeof SORTS)[number]["id"]>("name");

  const toggleCategory = (c: string) =>
    setChosen((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  const perCategory = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of items) counts.set(i.category, (counts.get(i.category) ?? 0) + 1);
    return counts;
  }, [items]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = items.filter((i) => {
      if (availableOnly && i.availability !== "in") return false;
      if (chosen.length && !chosen.includes(i.category)) return false;
      if (!q) return true;
      return `${i.name} ${i.blurb} ${i.category}`.toLowerCase().includes(q);
    });
    const order: Record<Availability, number> = { in: 0, soon: 1, out: 2 };
    return [...filtered].sort((a, b) => {
      if (sort === "deposit-low") return a.deposit - b.deposit;
      if (sort === "deposit-high") return b.deposit - a.deposit;
      if (sort === "availability") return order[a.availability] - order[b.availability] || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name);
    });
  }, [items, query, chosen, availableOnly, sort]);

  return (
    <Layout current="/index.html">
      <section className="masthead">
        <div className="shell">
          <p className="eyebrow">14 Mill Lane · Riverbend</p>
          <h1>Borrow the tool, not the clutter</h1>
          <p className="lede">
            Over four hundred tools, shared by the people who live here. Members take up to three items for seven
            days. Annual membership is £35 for the whole household.
          </p>
        </div>
      </section>

      <section className="section">
        <div className="shell catalogue">
          <form className="filters" aria-label="Filter the collection" onSubmit={(e) => e.preventDefault()}>
            <fieldset>
              <legend>Search</legend>
              <label className="visually-hidden" htmlFor="q">Search the collection</label>
              <input id="q" type="search" placeholder="Drill, ladder, strimmer…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </fieldset>

            <fieldset>
              <legend>Category</legend>
              {CATEGORIES.map((c) => (
                <label className="opt" key={c}>
                  <input type="checkbox" checked={chosen.includes(c)} onChange={() => toggleCategory(c)} />
                  {c}
                  <span className="count">{perCategory.get(c) ?? 0}</span>
                </label>
              ))}
            </fieldset>

            <fieldset>
              <legend>Availability</legend>
              <label className="opt">
                <input type="checkbox" checked={availableOnly} onChange={(e) => setAvailableOnly(e.target.checked)} />
                On the shelf now
              </label>
            </fieldset>

            {chosen.length || query || availableOnly ? (
              <button className="btn ghost small" type="button" onClick={() => { setChosen([]); setQuery(""); setAvailableOnly(false); }}>
                Clear filters
              </button>
            ) : null}
          </form>

          <div>
            <div className="results-head">
              <span className="count">
                {items.length === 0 ? "Collection not loaded" : `${shown.length} of ${items.length} items`}
              </span>
              <span className="spacer" />
              <label className="visually-hidden" htmlFor="sort">Sort by</label>
              <select id="sort" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
                {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>

            {shown.length === 0 ? (
              <div className="panel">
                <div className="empty">
                  <p style={{ marginBottom: 6, fontWeight: 650, color: "var(--ink)" }}>
                    {items.length === 0 ? "The collection is not available yet" : "Nothing matches those filters"}
                  </p>
                  <p style={{ margin: 0 }}>
                    {items.length === 0
                      ? "Tools appear here once the collection can be loaded."
                      : "Try clearing a filter or searching for something broader."}
                  </p>
                </div>
              </div>
            ) : (
              <ul className="items">
                {shown.map((i) => (
                  <li className="item" key={i.id}>
                    <div className="thumb" aria-hidden="true" />
                    <h3><a href={`/item.html?id=${i.id}`}>{i.name}</a></h3>
                    <p className="meta">{i.category} · £{i.deposit} deposit</p>
                    <p className="meta">{i.blurb}</p>
                    <div className="foot">
                      <span className={`tag ${i.availability}`}>
                        {i.availability === "in" ? "On the shelf" : i.availability === "soon" ? "Back soon" : "Out"}
                      </span>
                      <a className="btn small" href={`/item.html?id=${i.id}`} style={{ marginLeft: "auto" }}>Details</a>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>
    </Layout>
  );
}

createRoot(document.getElementById("root")!).render(<Catalogue />);
