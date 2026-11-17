// CI performance gate for the remote browser (portfolio performance upgrade, 2026-11-16). Reads the reports of
// scripts/portfolio-perf.mjs run against the development server with the fixture sites on a throttled visitor link
// (5 Mbit/s down, 60 ms) and fails if the stream regresses to the behaviour measured on production before the upgrade
// (frames rendered as fast as possible, pushed regardless of the link, a backlog of stale pictures):
//   node scripts/remote-browser-perf-gate.mjs static.json animated.json
const [staticFile, animFile] = process.argv.slice(2);
const { readFileSync } = await import("node:fs");
const st = JSON.parse(readFileSync(staticFile, "utf8")), an = JSON.parse(readFileSync(animFile, "utf8"));
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"} ${msg}`); if (!ok) failed++; };
const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

// Responsiveness on a 5 Mbit/s visitor link (static page: the picture moves only because of the input).
const d = st.devices.desktop5m, m = st.devices.pixel5m;
check(!d?.error && num(d?.scrollSingle?.visibleMedMs) !== null && d.scrollSingle.visibleMedMs <= 500, `desktop, 5 Mbit/s: wheel scroll → visible ${d?.scrollSingle?.visibleMedMs} ms (≤ 500)`);
check(!m?.error && num(m?.swipe?.visibleMedMs) !== null && m.swipe.visibleMedMs <= 700, `phone, 5 Mbit/s: touch swipe → visible ${m?.swipe?.visibleMedMs} ms (≤ 700)`);
// An always-animating page on the same link: no flood, no backlog, no wasted rendering.
const a = an.devices.desktop5m, s = a?.serverStats;
check(!a?.error && !!s, "animated page: the server reports stream statistics (v2 flow control active)");
if (s) {
  check(s.v2 === true, "the viewer and server negotiated flow control (v2)");
  check(s.produced <= s.sent * 2.2 + 5, `Chromium rendered ${s.produced} frames for ${s.sent} sent (≤ 2.2×: at most one look-ahead frame — was 3× before)`);
  check(num(s.rttMedMs) !== null && s.rttMedMs <= 400, `frame round trip (sent → drawn → acknowledged) ${s.rttMedMs} ms (≤ 400: no backlog)`);
  check(s.inFlight <= 6, `frames in flight ${s.inFlight} (≤ 6: bounded — the bound adapts to the measured round trip)`);
  check(num(s.inflightCap) !== null && s.inflightCap >= 1 && s.inflightCap <= 6, `adaptive in-flight bound ${s.inflightCap} (1–6)`);
  check(num(s.chromeLimit) !== null && s.chromeLimit >= 2, `learned Chromium frame limit ${s.chromeLimit} (≥ 2 — a limit of 1 halved desktop frame rates on production)`);
}
// The backlog itself: on an animating page the old stream filled the link, so a scroll was not visible within 1.6 s.
check(num(a?.scrollSingle?.visibleMedMs) !== null && a.scrollSingle.visibleMedMs <= 600, `animated page, 5 Mbit/s: wheel scroll → visible ${a?.scrollSingle?.visibleMedMs} ms (≤ 600 — not seen within 1.6 s before)`);
check(num(a?.idle?.fps) !== null && a.idle.fps <= 32, `idle animation streamed at ${a?.idle?.fps} fps (≤ 32 — capped at 30, was up to 60)`);
check(num(a?.idle?.kbPerSec) !== null && a.idle.kbPerSec <= 620, `idle bandwidth ${a?.idle?.kbPerSec} KB/s (within the 5 Mbit/s link — no queue builds: see the round trip above)`);
console.log(failed ? `${failed} performance check(s) failed` : "remote-browser performance gate passed");
process.exit(failed ? 1 : 0);
