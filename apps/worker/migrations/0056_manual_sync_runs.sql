CREATE TABLE IF NOT EXISTS manual_sync_runs (
  id TEXT PRIMARY KEY NOT NULL,
  connector_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'all',
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'running', 'completed', 'failed', 'needs_user_action', 'cancelled'
  )),
  error_code TEXT,
  last_error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_sync_runs_one_active
  ON manual_sync_runs (connector_id)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_manual_sync_runs_completed
  ON manual_sync_runs (completed_at DESC);

ALTER TABLE sync_jobs ADD COLUMN last_error_code TEXT;
