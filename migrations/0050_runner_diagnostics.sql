-- Node 1 dispatch-to-GPU diagnostic (Founder P0 directive, 2026-10-30).
-- One diagnostic = one real ai_jobs row (workflow 'gpu_diagnostic', provider 'local-runner') served by the self-hosted
-- runner through the existing signed draft channel (/api/builds/runner/ai/claim → local Ollama → /ai/complete).
-- Every transition is recorded as a checkpoint D01–D13 with its own evidence, so the first transition that fails or
-- cannot be proven is visible to the Owner without access to the machine. Runner-side checkpoints (D07–D11) carry the
-- runner's clock and are stored with the platform's receipt time next to it; nothing is inferred or back-filled.
CREATE TABLE runner_diagnostics (
  id TEXT PRIMARY KEY,                            -- diag_…
  correlation_id TEXT NOT NULL UNIQUE,            -- corr_… (sent to the runner, echoed in every runner checkpoint)
  ai_job_id TEXT NOT NULL UNIQUE REFERENCES ai_jobs(id),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  result_json TEXT                                -- sanitized runner-reported metrics, written on D12
);

CREATE TABLE runner_diagnostic_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  diagnostic_id TEXT NOT NULL REFERENCES runner_diagnostics(id) ON DELETE CASCADE,
  code TEXT NOT NULL CHECK (code IN ('D01','D02','D03','D04','D05','D06','D07','D08','D09','D10','D11','D12','D13')),
  ok INTEGER NOT NULL CHECK (ok IN (0,1)),
  at TEXT NOT NULL,                               -- when it happened (runner clock for runner checkpoints)
  recorded_at TEXT NOT NULL,                      -- when the platform stored it
  source TEXT NOT NULL CHECK (source IN ('platform','runner')),
  component TEXT NOT NULL,
  worker TEXT,                                    -- runner id that reported or was involved
  error TEXT,
  evidence TEXT                                   -- sanitized JSON
);
CREATE INDEX runner_diagnostic_checkpoints_diag ON runner_diagnostic_checkpoints(diagnostic_id, code, id);
