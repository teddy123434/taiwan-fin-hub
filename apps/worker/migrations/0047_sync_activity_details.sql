CREATE TABLE sync_activity_runs (
  id TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL REFERENCES scheduled_sync_batches(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  captured_at TEXT,
  published INTEGER NOT NULL DEFAULT 0,
  materialized INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sync_activity_runs_batch ON sync_activity_runs(batch_id, connector_id);
CREATE TABLE sync_activity_changes (
  run_id TEXT NOT NULL REFERENCES sync_activity_runs(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  change_kind TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY (run_id, entity_type, record_id)
);
CREATE TABLE sync_activity_details (
  run_id TEXT NOT NULL REFERENCES sync_activity_runs(id) ON DELETE CASCADE,
  activity_id TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY (run_id, activity_id)
);
