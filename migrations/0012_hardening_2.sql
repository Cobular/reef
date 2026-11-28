-- Second hardening pass (DESIGN.md "Abuse and security"). Additive only: two new columns, three
-- new tables, no table rebuilds.

-- Portal sessions: a session cookie issued at or before this time is refused. Signing out,
-- banning and unbanning set it to the current time, which ends the account's sessions in every
-- browser.
ALTER TABLE users ADD COLUMN sessions_valid_after INTEGER NOT NULL DEFAULT 0;

-- When the first upload request for a pending file arrived with the declared Content-Length. The
-- cron job sweeps a pending upload that never started after 5 minutes; one that started keeps
-- the longer sweep (src/files/cleanup.ts).
ALTER TABLE files ADD COLUMN upload_started_at INTEGER;

-- Uploads created per account per UTC day (`day` is floor(epoch ms / 86 400 000)), keyed by
-- GitHub ID. A counter rather than a count of file rows, so deleting the account (which deletes
-- its files) doesn't hand the day's uploads back. No foreign key. The cron job deletes rows from
-- earlier days.
CREATE TABLE uploads_started (
  day INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  started INTEGER NOT NULL,
  PRIMARY KEY (day, user_id)
) WITHOUT ROWID;
INSERT INTO uploads_started (day, user_id, started)
  SELECT created_at / 86400000, owner_id, COUNT(*) FROM files
  WHERE created_at >= (CAST(strftime('%s', 'now') AS INTEGER) / 86400) * 86400000
  GROUP BY created_at / 86400000, owner_id;

-- New uninvited accounts per UTC day, for the open-signup cap. Deleting an account doesn't
-- decrement it. The cron job deletes rows from earlier days.
CREATE TABLE signups_daily (
  day INTEGER PRIMARY KEY,
  created INTEGER NOT NULL
);
INSERT INTO signups_daily (day, created)
  SELECT created_at / 86400000, COUNT(*) FROM users
  WHERE created_at >= (CAST(strftime('%s', 'now') AS INTEGER) / 86400) * 86400000
  GROUP BY created_at / 86400000;

-- Accounts that have had a counted download of a file. Only they may fetch a range that doesn't
-- start at byte 0 without it counting as a download. Rows go with the file row (purged a day
-- after expiry); account deletion deletes the account's rows.
CREATE TABLE download_receipts (
  file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (file_id, user_id)
) WITHOUT ROWID;
