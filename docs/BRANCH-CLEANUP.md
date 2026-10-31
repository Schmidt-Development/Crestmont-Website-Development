# Branch and pull-request cleanup (CREST-GAP-062, CREST-GAP-058)

Prepared 2026-10-29 from `git fetch` of every remote branch and `git cherry origin/main <branch>` (a branch is "merged" when every one of its commits is already on `main`, by patch identity). **Nothing has been deleted or closed.** A repository admin does that, after the branch consolidation PR (#28, CREST-GAP-018) is merged, so no stranded fix is lost.

How to delete a branch: GitHub → Code → Branches → trash icon, or `git push origin --delete <branch>`. Closing a PR: open it → "Close pull request" with a comment pointing to the PR that superseded it.

## 1. Merged and stale: safe to delete now (12)

Every commit on these branches is already on `main`; deleting them loses nothing.

| Branch | Last commit | Notes |
|---|---|---|
| `claude/backend-pending` | 2026-10-27 | |
| `claude/ci-dom-iterable` | 2026-10-27 | PR #1 (merged) |
| `claude/consolidate-frontend-into-staging` | 2026-10-28 | PR #24 (merged) |
| `claude/d1-restore-verification` | 2026-10-28 | PR #15 (merged) |
| `claude/frontend-redesign` | 2026-10-28 | **Still contains `.github/workflows/deploy-frontend-preview.yml`, which deploys the retired `crestmont-platform-frontend-preview` Worker on a push to this branch (CREST-GAP-058). Delete first.** |
| `claude/production-d1-id` | 2026-10-27 | PR #12 (merged) |
| `claude/production-mfa-key` | 2026-10-27 | PR #13 (merged) |
| `claude/production-provisioning` | 2026-10-27 | PR #10 (merged) |
| `claude/staging-credential-remediation` | 2026-10-28 | PR #20 (merged) |
| `claude/staging-email-recipient-guard` | 2026-10-28 | PR #14 (merged) |
| `claude/staging-public-no-preview-gate` | 2026-10-28 | PR #25 (merged) |
| `claude/staging-verify-propagation` | 2026-10-28 | PR #21 (merged) |

## 2. Abandoned work-in-progress snapshots: delete (2)

| Branch | Last commit | Notes |
|---|---|---|
| `wip/parallel-areas` | 2026-10-26 | One "WIP snapshot" commit, 165 commits behind `main`; its areas were rebuilt and merged since. |
| `wip/workstreams-3` | 2026-10-27 | One "WIP snapshot (untested)" commit, 154 commits behind `main`. |

## 3. Superseded pull requests: close with a comment, then delete the branch

| PR | Branch | Superseded by | Why it must not be merged |
|---|---|---|---|
| #8 Production readiness | `claude/production-readiness` | #20 (merged) and #28 | Merging it as-is would re-enable the staging preview gate and roll `ACCESS_EPOCH` back from 3 to 2 (CREST-GAP-018). |
| #9 Frontend preview: encrypt access notes | `claude/frontend-preview-encrypt-access` | #20 (merged; sealed delivery) and #24 (preview Worker retired) | **Carries `deploy-frontend-preview.yml`** (CREST-GAP-058). |

## 4. Duplicate branch of PR #18

`claude/security-legal-readiness-after-pr20` (4 unique commits) is a second variant of PR #18 (`claude/security-legal-production-readiness`, 6 unique commits). PR #28 (CREST-GAP-018) chooses one variant and lands its changes; after #28 merges, close #18 if it is fully included and delete **both** branches.

## 5. Keep (active or awaiting a decision)

`main`; the open closeout PRs and their branches (#26–#29 and this PR); `claude/ai-website-builder-readiness` (#16); `claude/crestmont-retell-backend` (#17, "do not merge yet") and `claude/closeout-retell`; `claude/staging-mfa-encryption` (#19), `claude/d1-closeout` (#22), `claude/staging-health-closeout` (#23) — close these three only after #28 lands their fixes; `claude/crestmont-integration-closeout` (2 unmerged documentation commits: review, then merge or delete).

## 6. Dependabot (CREST-GAP-063)

`main` now pins every action to a full commit SHA with a `# vN` comment. Dependabot keeps updating pinned actions (it rewrites the SHA and the comment), so the open bump PRs only need to be **recreated** against the pinned files: comment `@dependabot recreate` on each, or close them and let the weekly run reopen them.

| PR | Bump | What it needs |
|---|---|---|
| #5 | `actions/upload-artifact` 4 → 7 | Previously failed only because `tests/evidence-secret.test.ts` and `tests/ops.test.ts` hard-coded `upload-artifact@v4`; both now accept any version or SHA. Recreate; review the v5–v7 changes (artifact immutability, Node 24 runtime) and check that `staging-access-sealed` and `ci-evidence` uploads still appear. |
| #3 | `actions/setup-node` 4 → 7 | Recreate; review the major versions (Node 24 runtime of the action, caching defaults). Our workflows set `node-version: "22.x"` explicitly. |
| #6 | `actions/checkout` 4 → 7 | Recreate; review `persist-credentials` defaults across majors (we set `persist-credentials: false` where a token is later used). |
| #7 | `github/codeql-action` 3 → 4 | 106 commits behind `main`; recreate. v4 runs on Node 24; `init` and `analyze` must move together. |

## 7. Retired preview Worker (CREST-GAP-058, Founder part)

No workflow on `main` deploys `crestmont-platform-frontend-preview` (guarded by `tests/workflow-security.test.ts`). Remaining human steps: delete the branches in §1/§3 that still carry `deploy-frontend-preview.yml`; delete the Worker (Cloudflare dashboard → Workers & Pages → `crestmont-platform-frontend-preview` → Settings → Delete) if it still exists; delete the GitHub environment `frontend-preview` and its two secrets (Settings → Environments → frontend-preview → Delete environment).
