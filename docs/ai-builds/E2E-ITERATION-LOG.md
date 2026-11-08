# Artifact Builder — E2E iteration log

One row per real end-to-end run of `scripts/design-locked-e2e.ts --stage full`. Kept so a diagnosis is made once:
after a context reset or a new session, read this before re-deriving anything.

Fixture unless stated: the Founder's own `01-vesper-rowe-law.zip` — one self-contained HTML document, 174 KB,
one Google Fonts stylesheet and three Unsplash photographs (ten pinned assets once the stylesheet's woff2 files
are resolved in round two).

| # | Commit | Failed checks | Root cause | Fix | Regression test |
|---|--------|---------------|-----------|-----|-----------------|
| 1 | `19c6a5c` | `SCAN-CLEAN` undetermined | clamd listens on `scan_net` and publishes no host port, but the harness runs the scanner in-process on the host | throwaway clamd on `127.0.0.1:3310` reusing the signature volume; the hardened stack untouched | — (environment, not code) |
| 2 | `cf0568a` | `CONTRACT-AUTHOR` | the e2e read a **fixture** contract and required a `package.json`, so neither Model A authoring nor the single-document shape had ever run here | wired real Model A authoring; a directory with an HTML document is a frontend | `[SIMPLE-*]`, `ASSETS-ACQUIRED` |
| 3 | `876a33f` | `CONTRACT-AUTHOR` ×3 attempts | **contradiction**: every criterion had to carry a probe, and a page-content probe GETs the page, which is not in `apis` — Model A drafted the right thing and was refused | a probe may name a page of the approved design | `[DLC-12]` |
| 3 | `876a33f` | Model B `max_turns` 60/60/60, **13 context resets** | `OLLAMA_NUM_PARALLEL=2` halved the window; models advertise 262144, runner ran 65536 | 1 sequence × 131072 — same KV allocation, usable window ~55k → ~119k | verified by `/api/ps`: `ctx=131072`, 25.5 GB |
| 4 | `412091b` | `GATE-VISUAL` — approved `b2dd67f23666`, measured `5eaa292fbefd` | `5eaa292fbefd` is this artifact's fingerprint **without** its assets: the import had a resolver, the build had none, so the gate compared a page with its fonts against a page without them | one resolver, passed to both `importFrontend` and `runDesignLockedJob` | — |
| 5 | `d108065` | — (workflow change) | uploading authorized backend construction, skipping the preview the step exists for | upload authorizes nothing; one `approve-and-build` action, idempotent, holds the decision while preparation finishes | `[SIMPLE-01]`…`[SIMPLE-05]` |
| 6 | `d108065` | `loop detected: run_command repeated 4x` | `git log` ×6 then `ls .git` ×4: the workspace is a repository with **no commits** (the design-locked path never makes one), so git fails the same way in production | the prompt says there is no history to read; the e2e initialises the repo like the runner | `[DLJ-*]`, `[INT-*]` pass |
| 7 | `d108065` | `GATE-VISUAL` — approved `973c825990b3` vs measured `b2dd67f23666` | **the measurement is not deterministic**: four images carry `loading="lazy"` and part of the page is written by its own JavaScript, so `waitUntil: load` + `fonts.ready` + a flat 250ms measured one of two resting states, 12207px apart | a bounded `settle()` before every measurement and screenshot: images made eager and scrolled past, awaited and decoded, fonts awaited, document height held still across two samples | two imports of the same bytes must agree on the fingerprint |

| 8 | `bdb9c81` | `GATE-VISUAL` — approved `b2dd67f23666` vs measured `973c825990b3` | the gate compared the build's measurement against the baseline measured during **import** — a different container — so an environment difference was permanent drift blamed on Model B. Each path was now individually deterministic, which is what made the systematic difference visible | the gate compares against this build's own measurement of the unmodified artifact (`before`, already passed in and used only for state changes); divergence from the approved design stays reported by the drift check that owns that question | `[DLJ-17]` |

| 9 | `1682f9f` | `GATE-VISUAL` — "the rendering changed but nothing in the integration manifest said this page would change" | Model A declared `firm-figures-read` on `index`, kind `data-read`, serving `GET /api/firm-figures`, with **`expectChange: "none"`**. A data-read puts backend data on a page, so making it work is exactly what changes the rendering — the gate was told the page would look the same and reported the data arriving as drift | the validator refuses `expectChange: "none"` for `data-read` and `search`, naming the consequence; Model A's schema says which value to use and why | `[IM-014]` |

| 10 | `6fb4c2a` | `GATE-VISUAL` — `index at tablet [layout]: section spacing changed by 8616px` | **the two gates could not hold at once.** The visual gate passed at cycle 1 (no backend) and failed at cycle 2 once the backend worked, because data arriving where a placeholder was makes the page taller — and a `design-drift` finding was raised for the layout consequence of a content change the contract *declares*. The only way Model B could satisfy both was to stop the data arriving | a drift finding whose aspects are **only** `layout`, on a page whose content change is declared, is reported as the declared change. Palette, fonts and skeleton stay locked | `[DL-012]` |

| 11 | `6fb4c2a` | `GATE-VISUAL` — **0 drift findings**, 1 interactive state changed; `GATE-FUNCTIONAL` — a real Model B defect | the layout fix worked. The remaining visual item is the same defect in the other channel: interactive-state screenshot hashes captured before Model B existed, compared against the same states once the backend works. An inert form against a working one must differ — that difference is the work | the declaration that covers the resting page covers its states; on an undeclared page a changed state is still a failure. Also unblocks the loop: cycle 2 had scored identically to cycle 1 and stopped with two of four cycles unspent | `[DL-012]` covers the principle |

| 12 | `b5a1c39` | `GATE-FUNCTIONAL` — 4 passed, 4 failed | **`GATE-VISUAL` now passes: "the approved design held across 3 page view(s)".** The failures are real and the contract is right: `<b>28</b>` and `1,900+` ARE in the approved HTML (checked, not assumed), so the probe is protecting the frontend — Model B took the static figure out to inject it from the API, which is a change to an approved frontend | the brief now says the text a probe reports missing is text the approved page already contains: put it back, serve the approved file unchanged, add the API beside it. Feedback, not a gate change | — |

## Results by iteration

**Iteration 3** (`876a33f`) — 28 passed, 2 failed, 1 undetermined.
Model A accepted on attempt 1 (1 operation, 3 criteria, 3 probes). Model B: phases `success` at 55 / 29 / 18 turns,
**0 context resets**. `GATE-CONFORMANCE` passed. **`GATE-FUNCTIONAL` passed — 7 contract checks against the running
application.** Only `GATE-VISUAL` failed, on the asset mismatch above.

**Iteration 4** (`412091b`) — 27 passed, 3 failed, 1 undetermined.
Model A accepted on attempt 1 (1 operation, 5 criteria, 5 probes — a *different*, larger contract than iteration 3
from the same artifact). Model B: 2 cycles, **2 file changes**, phase ended `loop`. No server was written, so
`GATE-FUNCTIONAL` could not evaluate. This is **run-to-run variance in the local models**, not a regression from
the asset fix.

**Iteration 5** (`d108065`) — 28 passed, 2 failed, 1 undetermined.
Model A accepted on attempt 3 of 3 (1 operation, 4 criteria, 4 probes). Model B: 3 cycles, 8 file changes, **no
loop detection** — the git fix held. `GATE-CONFORMANCE` passed. **`GATE-FUNCTIONAL` passed — 8 contract checks
against the running application**, the second time in five runs that the generated backend worked. Only
`GATE-VISUAL` failed, and its own message gave the cause away: it had measured `b2dd67f23666`, which is the value
iteration 3's import produced from these same bytes. Both sides pinned 10 of 10 assets, 1359 KB, so the asset set
was identical and what differed was the rendering itself.

**Iteration 6** (`bdb9c81`) — 28 passed, 2 failed, 1 undetermined.
Model A accepted on attempt 1 (1 operation, 5 criteria, 5 probes). Model B: 2 cycles, 8 file changes.
`GATE-CONFORMANCE` passed. **`GATE-FUNCTIONAL` passed — 9 contract checks against the running application**, the
third working backend in six runs. `GATE-VISUAL` failed with approved `b2dd67f23666` against measured
`973c825990b3` — the same two values as iteration 5, with the same 12207px / 8616px deltas. Each measurement path
was deterministic by now, so the difference was systematic between import and build, which is what led to the
gate fix above. Eliminated along the way, cheaply and then reverted: the git repository in the build workspace was
**not** the cause — an import with git initialised still measured `b2dd67f236668efb`.

**Iteration 7** (`1682f9f`) — 28 passed, 2 failed, 1 undetermined. **The environment drift is gone**: no
"renders a different design from the one approved", no 12207px deltas. Per cycle:

| cycle | conformance | functional | visual |
|---|---|---|---|
| 1 | ok | no server yet | 3 findings |
| 2 | ok | no server yet | **ok — the approved design held across 3 page views** |
| 3 | ok | **ok — 10 contract checks passed** | 2 findings |

Every gate has now passed. Never simultaneously — which is what the `expectChange` fix above addresses. Model A
accepted on attempt 2 (1 operation, 6 criteria, 6 probes).

**Iteration 8** (`1682f9f`) — 28 passed, 2 failed, 1 undetermined. Per cycle:

| cycle | conformance | functional | visual |
|---|---|---|---|
| 1 | ok | no server yet | 1 — an interactive state hash changed, zero drift findings |
| 2 | ok | **ok** | **1** — `index at tablet [layout]: section spacing` |
| 3 | ok | ok | 4 — regressed; `6 element(s) gone (article.pcard ×4)` |

The closest the builder has come: cycle 2 had conformance and functional passing with the visual gate **one finding**
away. But this run's import measured `9591851fd93af2b9` — a **third** value.

**Correction, recorded because it was reported as settled.** Iteration 7's "DETERMINISTIC: b2dd67f236668efb" was
based on two runs. A third run falsified it. Two agreeing runs are not evidence of determinism for a page whose
content is written by its own JavaScript; the check now uses four. The `article.pcard` elements are built on
`DOMContentLoaded` and sized by `requestAnimationFrame`, so the document height can hold still for two samples
while the DOM is still being written — which is why height stability alone was insufficient and why `settle` now
waits for DOM quiescence (no mutations for 400ms, bounded at 4s) rather than for longer.

**Determinism, on better evidence** (`settle` with DOM quiescence): four import runs of the same bytes all
measured `b2dd67f236668efb`. Four is better than the two that were wrongly called conclusive, and still not proof —
what makes it more than coincidence is that the mechanism (waiting for mutations to stop) addresses the cause the
drift finding named (`article.pcard` elements built on `DOMContentLoaded`).

## Standing observations

- **Model A and Model B output varies between identical runs.** Iteration 3 produced a working backend; iteration 4
  produced none from the same bytes. Any claim that the builder "works" has to account for this, and the honest
  statement is a success *rate*, not a success.
- **Withdrawn, and worth recording as withdrawn.** An earlier note here said `node server.js & sleep …` "ran 38
  times" in iteration 4. It is not supported: the activity record keeps only the **first line** of a multi-line
  command, so 38 different commands sharing that prefix look identical in the log. The loop detector compares the
  call signature *and* its output (`r.sig === sig && r.out === out`), and it did not fire on those 38 — which is
  the correct answer, because a server start that returns different output each time is not a loop. The detector
  is sound; there was no defect here. What is real is the observability limit: a repeated-looking run of activity
  lines is not evidence of repetition.
- The visual gate reports `findings: undefined` when it did not run, and `gateScore` scores that as `1`. A
  "visual 1" in a stop message therefore means *did not run*, not *one finding* — this cost a wrong diagnosis once.
- Staging Worker `f0b8a7b2-77a6-467e-a39d-4cec55cf341b`; runner image `sha256:4a8367f4…`, reporting `slots: 4`,
  `gpu.maxConcurrent: 1`, `paidProviderAllowed: false`.
- Law Firm 02 (`prj_e302b182025b36d4ae905630`, artifact `fa_45741ac8e5c6c26c684e46a0`) waits on one
  staff-authenticated `retry-import`. Its four asset rows still read "blocked by the egress allowlist" from the
  pre-fix Worker; the deployed Worker now has the fix.
