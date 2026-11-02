# Research Agent — activation status and the minimum Founder action

Prepared **2026-11-02** for the 24/7 activation request. Capacity and funnel evidence: `CAPACITY.md`. Operating
procedure: `RUNBOOK.md` §9. Calling rules, unchanged: `COMPLIANCE-GATE.md`.

## Status: BLOCKED on one thing, and it is not code

**The Research Worker is NOT running, and this session could not start it.** Activation has to happen on Node 1, the
Founder's Windows workstation. This session is a cloud container, and it has no route there:

| Route checked | Result |
|---|---|
| Remote Control folders shared with this session | **None.** The connected-folder list came back empty — no folder on any of the Founder's computers is being served, and none is listed as unavailable either |
| Another Claude session on Node 1 to hand the work to | **None running** |
| Cloudflare / staging credentials in this session | **Not present.** No `wrangler`, no API token, so staging research cannot even be unpaused from here |
| Node 1's health endpoint, scheduled task, logs | **Unreachable** (`127.0.0.1:8789` is Node 1's own loopback, not this container's) |

Nothing was faked to paper over this. There is no "activated" claim anywhere in this repository, and the 24-hour
measurement window has **not** started, because nothing is producing data to measure.

## The minimum Founder action, in order

Everything that could be prepared without Node 1 has been (see "What is ready" below). These four steps are what
remains, and only the first two need a person at the keyboard.

1. **Merge the research branch to `main`** (`claude/eager-babbage-coz56n`). This matters for a reason beyond code
   shipping: merging to `main` deploys **staging**, which applies **migration 0064** and creates
   `research_runner_samples`. Without that table there is no 15-minute metric series, so a 24-hour report can show
   end-of-day totals and delivery times but **not hourly throughput, the peak sustained hour, or the best and worst
   periods** — which is most of what the proof run is for. No pull request was opened and nothing was merged: that is
   the Founder's call, through the existing protected workflow.
2. **Run the installer on Node 1**, in an elevated PowerShell, from a checkout of this repository at that merge
   (`RUNBOOK.md` §9 has the annotated version):

   ```powershell
   .\research-worker\windows\Install-ResearchWorker.ps1 `
     -PlatformUrl https://<staging host> `
     -States "" `
     -Concurrency 24 `
     -RunWhenLoggedOff `
     -Install
   ```

   No `-Model`: drafting stays off, so research never touches the GPU and the Website Builder keeps all of it.
   `-RunWhenLoggedOff` is what makes the run survive an unattended restart (see "Defect fixed" below). The installer
   asks for the platform secret and for the Windows password Task Scheduler needs; neither is written to the
   repository.
3. **Resume research** in `/staff/research` (Owner). It ships paused and stays paused until a person unpauses it.
4. **Wait for the first dataset scan before starting the clock.** The worker's first act is to copy the US subset of
   the Overture release; that release is **11.90 GB over 16 Parquet parts** (measured), of which about **3.8 GB** is
   read. Expect one to several hours at 0 evaluations/hour. Start the official 24-hour window when the dashboard's
   source row reads `current` with a release, or the measurement will mostly record a download.

Then the report is a command (or the daily `Research performance report` workflow):

```bash
node --no-warnings scripts/research-24h-report.ts --hours 24 --target 25000 --out evidence
```

## Alternative, if the Founder would rather Claude did steps 2–4
Share Node 1's repository folder over Remote Control — in the Claude desktop app under Settings → Claude Code →
Remote Control, or by running `claude remote-control` in that folder — and a session can then act on that machine. It
is not shared today, which is why this one could not.

## What is ready, so activation is a short job

- **The worker code, tested.** GPU admission guard, non-blocking optional drafting, bounded draft queue, durable
  checkpoints, per-host politeness, idempotent batch delivery, deduplication and suppression: all on the branch, with
  the worker and platform test suites passing and both typechecks clean.
- **A GPU-free install path.** The installer previously told operators to pass `-Model`, which would have switched on
  Ollama use against the Website Builder's RTX 5090. The documented path is now explicitly model-free, the installer
  prints which mode it configured, and `settings.env` now carries `HTTP_CONCURRENCY` and the GPU-guard settings so
  they can be tuned without editing code.
- **A metric series and a report.** Migration 0064 plus `scripts/research-24h-report.ts` and the
  `Research performance report` workflow. The report keeps every funnel stage separate, derives rates only from time
  it actually observed, handles the UTC day boundary and counter resets, refuses to state a daily figure for an
  unfinished window, and names the limiting factor (no worker / paused / credentials refused / delivery backlog /
  qualification yield / source supply / CPU / verification throughput) with the smallest next change for each.
- **An alert for the obvious failure.** If research is resumed and no worker checks in for 30 minutes — or has never
  checked in — the Owners are emailed by the existing `ops_alerts` job.

## Defect fixed: the worker would not have survived a restart unattended

The scheduled task was registered with an **at-logon trigger only**, and `RunLevel Limited` with an interactive
token. After an unattended Windows restart — a patch reboot, a power cut — the task would not start until that
account signed in again, which is exactly the "don't make the Founder restart it every few hours" failure the
activation request names. `-RunWhenLoggedOff` now adds a boot trigger and registers the task with the account's
stored password, which is required because the platform secret is DPAPI-protected for that user and a password-less
(S4U) task cannot unprotect it. Without the switch the installer now prints a warning saying the worker will not come
back on its own.

## What to expect from 25,000 qualified prospects a day

Set against measured numbers, not hopes (`CAPACITY.md` §4):

- 25,000 qualified/day needs **163,400 businesses evaluated/day** (6,808/hour, 1.9/second) at the measured 15.3%
  qualification rate — about **concurrency 80** and **884,000 HTTP requests a day**.
- **One** such day may be achievable; it has never been tested. The 4,168 businesses/hour reference is an 18-minute
  burst from a datacenter IP in one small area, with ~25% of checks already refused by robots rules or bot
  protection. Holding ~6,800/hour for 24 hours on a home or office connection is the real unknown, and it is exactly
  what a proof run would answer.
- **Sustained, it is not available.** The national pool is ≈ 1.41 M qualified businesses (9.20 M US places with a
  phone × 15.3%), so 25,000/day lasts about **56 days** and then falls to new business formation plus newly-broken
  sites — bounded above by **~3,856/day** even if the entire inventory turned over annually, and realistically a few
  hundred. That is a supply fact, not a throughput problem, and no amount of concurrency changes it.
- A 24-hour run should therefore be judged on **evaluations per hour sustained, failure rate and accuracy**, with the
  qualified count read as the yield of those evaluations.

## Unchanged

No production deployment. No outbound calling, no consent or DNC change, no bulk promotion into the callable CRM —
promotion stays a per-prospect Owner decision through the CRM intake engine. The Website Builder's source,
configuration, scheduler, runner and jobs were not touched, and nothing was restarted. "Verified callable today"
remains 0 by design.
