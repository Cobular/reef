-- Service-wide resident bytes, refreshed by the cron job, so create_upload no longer sums every
-- live file. create_upload adds the files inserted since (files.rowid > max_file_rowid), so the
-- 30 GB cap still holds between cron runs (src/files/repo.ts serviceResidentBytes).
CREATE TABLE service_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- SUM(size) of pending and ready files when the cron job last ran.
  resident_bytes INTEGER NOT NULL,
  -- The highest files rowid at that moment.
  max_file_rowid INTEGER NOT NULL
);
