-- D1 bills every index entry a write touches as a row written. This migration removes index
-- entries that only served rare paths:
-- - read_positions, messages and file_shares become WITHOUT ROWID tables: the primary key is the
--   table, so an insert no longer also writes a sqlite_autoindex entry.
-- - read_positions_school_seq (0006) goes back to an index on school_id alone. insertMessage no
--   longer reads read positions (schools.seq_floor, 0007), and with last_seq in the index every
--   read-position update wrote a second row.
-- - messages_created goes: message retention now walks each school's messages in seq order on the
--   primary key (src/schools/cleanup.ts).
-- - files_state_created goes: the stale-upload sweep reads pending files through
--   files_state_expires (state = 'pending' is a handful of in-flight uploads).
-- Nothing references these three tables, so rebuilding them (create, copy, drop, rename) cascades
-- nothing; their own foreign keys and ON DELETE CASCADE clauses are declared again below.
PRAGMA defer_foreign_keys = true;

CREATE TABLE read_positions_new (
  session_handle TEXT NOT NULL REFERENCES sessions (handle) ON DELETE CASCADE,
  school_id TEXT NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
  last_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_handle, school_id)
) WITHOUT ROWID;
INSERT INTO read_positions_new (session_handle, school_id, last_seq)
  SELECT session_handle, school_id, last_seq FROM read_positions;
DROP TABLE read_positions;
ALTER TABLE read_positions_new RENAME TO read_positions;
-- Used by the ON DELETE CASCADE from schools (otherwise a scan of every read position when a
-- school is deleted) and by listMemberships' per-school read_seq lookup.
CREATE INDEX read_positions_school ON read_positions (school_id);

CREATE TABLE messages_new (
  school_id TEXT NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  sender_id INTEGER NOT NULL REFERENCES users (id),
  session_type TEXT NOT NULL,
  product TEXT NOT NULL,
  label TEXT NOT NULL,
  text TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]', -- JSON array of {file_id, key?}
  created_at INTEGER NOT NULL,
  reply_to INTEGER,                       -- see 0005; not a foreign key
  PRIMARY KEY (school_id, seq)
) WITHOUT ROWID;
INSERT INTO messages_new (school_id, seq, sender_id, session_type, product, label, text,
    attachments, created_at, reply_to)
  SELECT school_id, seq, sender_id, session_type, product, label, text, attachments, created_at,
    reply_to FROM messages;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
-- Same definitions as 0002: the exact per-account send limit, and the attachment-key cleanup.
CREATE INDEX messages_sender_created ON messages (sender_id, created_at);
CREATE INDEX messages_keyed ON messages (created_at) WHERE instr(attachments, '"key"') > 0;

CREATE TABLE file_shares_new (
  file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users (id),
  PRIMARY KEY (file_id, user_id)
) WITHOUT ROWID;
INSERT INTO file_shares_new (file_id, user_id) SELECT file_id, user_id FROM file_shares;
DROP TABLE file_shares;
ALTER TABLE file_shares_new RENAME TO file_shares;
CREATE INDEX file_shares_user ON file_shares (user_id);

DROP INDEX files_state_created;
