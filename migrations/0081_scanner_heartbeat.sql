-- Malware scanner liveness (SEC-003, F-02). ADDITIVE ONLY.
--
-- The malware-scan feed could only see verdicts. A scanner that stopped, lost its ClamAV daemon, or kept scanning
-- with signatures weeks out of date looked the same as one that was working: files simply stayed 'pending' (safe,
-- but silent) or were labelled clean by an engine that no longer knew current threats. The scanner on Node 1
-- (scanner/) now reports a signed heartbeat to POST /api/scan/heartbeat every few minutes; one row per scanner.
-- Facts only: no file name, no organization, no verdict detail.
CREATE TABLE scanner_heartbeats (
  scanner_id TEXT PRIMARY KEY,           -- the scanner's own stable name (e.g. "node1-clamav"), [a-z0-9-], ≤ 40
  engine TEXT,                           -- clamd VERSION: "ClamAV 1.4.1/27450/Tue Nov  4 08:26:19 2026"
  signatures_at TEXT,                    -- ISO time of the signature database, parsed from the engine string
  daemon_ok INTEGER NOT NULL CHECK (daemon_ok IN (0, 1)),
  detail TEXT,                           -- why the daemon is not ok, or the scanner's last error (≤ 300, redacted)
  scanned_total INTEGER NOT NULL DEFAULT 0,
  failed_total INTEGER NOT NULL DEFAULT 0,
  seen_at TEXT NOT NULL
);
