# Staging remediation — status, 2026-11-05

**This is a status, not a completion report.** The 36-item closeout directive is not finished. Of what
remains, most is waiting on a decision or an account only the Founder can provide; a little is waiting on one
open technical question. Both lists are below, with what has actually been proven rather than what was
attempted.

Readiness as derived from evidence (not hand-maintained): **149 platform requirements, 113 complete, 36
outstanding.** The derivation is unchanged in method since it was built — nothing here was closed by editing
a status field.

## 1. What is fixed and merged

| PR | What it was |
|---|---|
| #145 | Migration `0068` used a **56-byte LIKE pattern**; D1 caps them at 50. This was the step-13 failure that blocked every staging deploy. The test adapter now enforces D1's limit, so the next one fails in `npm test`. |
| #146 | **Seven Owner pages returned 500 to a long search** — a pasted email address was enough. Twenty sites now build patterns through one capped helper. Also: **BLK-006 gated twelve requirements**, so finishing the attorney review would have reported a completed penetration test; split into BLK-016–020 with no requirement changing state. |
| #147 | **D1 read retry** for Cloudflare's transient faults (writes never retried). First **live TLS check** — certificate, TLS versions, HSTS, http redirect. |
| #149 | **SEC-03 scanner transport**: `recordScanResult` and `filesAwaitingScan` were complete, tested and reachable from nothing, so ClamAV on Node 1 could not have reported a verdict. Also the schema check that said "column missing" when the query simply had not answered. |
| #151 | **Nothing stopped `[env.staging]` pointing at production** — one word would have sent staging migrations at the production database. Plus the **dedicated scanner credential** (`FILE_SCANNER_SECRET`), and three defects in my own TLS check. |
| #153 | Pinned the **append-only premise** the readiness evidence cache depends on, and made the deploy read the **Worker's own log**, which still works when D1 is the fault. |

## 2. The open technical question: bursts of 500s on staging

Not fixed, and deliberately not attributed yet.

**What is established.** For one request the cause is now *recorded* rather than inferred:
`500 /services/booking-scheduling`, `D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10
second window`, at `loadContent`. That is a trivial public page running one indexed lookup — which fits a
*shared budget exhausted by something else* far better than an expensive page.

**What is not established.** The other 500s have no recorded cause. The failing set moves between deploys, and
no individual page reproduces locally. Two candidates remain: D1 refusing writes, or failures that never
reach the Worker's handler.

**How it gets settled.** Cloudflare's own per-statement D1 analytics, dispatch-only and read-only, over the
window of a failing deploy. A prediction was written down first, so the data is not fitted afterwards: if the
cause is a shared budget, the heavy rows-read statements should belong to the E2E writes and the
every-minute promotion cron, and the per-minute peak should come *before* the 500s. If instead `loadContent`
or the readiness aggregate tops that table, the bounded readiness load did not go far enough.

## 3. What needs the Founder

Nine of the ten open blockers are Founder-owned. None can be closed from inside the repository.

| Blocker | What is needed | Consequence while open |
|---|---|---|
| **BLK-005** | Resend account, verified sending domain, `RESEND_API_KEY` | No email is delivered. Also means the 15-minute in-Worker alerting writes to the development outbox and reaches nobody. |
| **BLK-006** | Attorney review of the legal suite; accountant's tax position; record the entity in Business settings | Production checkout stays closed. |
| **BLK-016** | A registered non-residential business address, or written confirmation that none will be published | The disclosures page prints no address. |
| **BLK-017** | An independent security review or penetration test | SEC-007 cannot be established from inside this repository, by your own instruction. |
| **BLK-018** | Approve the retention periods with counsel | Periods stay default-off; current conservative behaviour continues. |
| **BLK-019** | Set staffed support hours and the first-response target | The public policy page cannot state them. |
| **BLK-020** | Record the production launch authorization | Production launch withheld, as directed. |
| **BLK-014** | A vector or ≥1000 px master of the existing logo, if print or hero use arises | Low. Social and app-icon sizes are already served. |
| **BLK-015** | Install and start the build runner on Node 1 with `BUILD_RUNNER_SECRET` | No AI draft has ever been produced in a deployed environment. |

Also Founder-only, outside the blocker register:

- **`FILE_SCANNER_SECRET`** and ClamAV on Node 1 — the transport now exists; absent is a safe state
  (`/api/scan/*` answers 503, files stay `pending`, nothing is ever labelled clean without a verdict).
- **`STAGING_MFA_ENCRYPTION_KEY`** as a GitHub secret matching the Worker key — until then demo 2FA secrets
  are written in plaintext and `mfa-at-rest:staging` cannot go healthy (FEED-02).
- **Real staging Turnstile keys** — the repository runs Cloudflare's always-pass test keys (FEED-01).
- **"Always Use HTTPS"** in Cloudflare → SSL/TLS → Edge Certificates. Staging answers **HTTP 200 over plain
  http with no redirect**; found by the first live TLS check.
- **Minimum TLS version** in the same place, if TLS 1.0/1.1 are still accepted. The check reports this as a
  warning rather than failing a deploy that cannot change it.

## 4. SEC-01: five of six bullets proven, and why the sixth is yours

Credentials were rotated (`ACCESS_EPOCH` 3) and the rotation **completed** — verified read-only on every
deploy. Delivery works. The historical public artifacts are **gone**: measured 2026-11-05 ~05:00 UTC, 100 artifacts retained, oldest
`2026-11-04T07:50:12Z`, nothing from the 2026-10-27/28 exposure window and nothing whose name suggests
unsealed credentials or a database export. The count moves as deploys run; the command to re-check is in
`docs/security/SECURITY-READINESS-2026-10-28.md` §4a.
Recurrence is prevented and tested.

The sixth bullet — *confirm old credentials are rejected* — is proven only by unit tests, not by a live run.
The step that proves it runs only in a deploy that rotates, and it has been skipped in every deploy examined
(the 120 most recent completed deploys at the time of checking, roughly #40 to #159). **F-18 therefore stays open**; closing it on five of six would be the status edit this
directive forbids. One deploy with `rotate_credentials=true` would close it, and the safeguard you set —
prove a safe recovery path first — is now satisfied. It is not run unasked because it changes every demo
password and 2FA key, including your own staging access.

## 5. What is still unproven, stated plainly

- **VER-01…06** need a staging deploy that completes green. None has yet.
- The **rollback rehearsal** and **restore drill** are gated on a successful deploy and have been skipped all
  day; they last succeeded 2026-11-04 08:44, so the capability is proven but the current evidence is not.
- The **Worker-log capture** has not yet produced output on a real run. Its first attempt reported silence it
  had never listened for, because it was bounded at 25 minutes and the failing sweep ran at minute 26.
- Four instruments I built failed quietly on their first run tonight — a gate whose exit code was swallowed
  by a pipe, a step that would not parse, a cleanup ordered before the step that read its file, and the
  capture above. Each could not tell *no signal* from *not listening*. Treat any instrument here as unproven
  until it has been seen to produce output.

## 6. Constraints honoured

No production deploy. No production credential or migration touched. No payment collection or outbound
calling enabled. No spending. No credential rotated. No status field edited to make a dashboard green.
