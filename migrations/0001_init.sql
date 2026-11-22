-- Reef schema. All times are Unix epoch milliseconds (INTEGER).
-- No table holds a file key, except message attachments (blanked by the cron job at expiry).

CREATE TABLE users (
  id INTEGER PRIMARY KEY,                 -- GitHub numeric user ID
  login TEXT NOT NULL,                    -- GitHub login, refreshed on every sign-in
  created_at INTEGER NOT NULL,
  banned INTEGER NOT NULL DEFAULT 0 CHECK (banned IN (0, 1))
);
CREATE INDEX users_login ON users (login COLLATE NOCASE);

CREATE TABLE invites (
  login TEXT PRIMARY KEY COLLATE NOCASE,  -- GitHub login allowed to sign up in invite mode
  created_at INTEGER NOT NULL
);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users (id),
  name TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'deleted')),
  r2_upload_id TEXT,                      -- set only for multipart uploads
  lifetime_minutes INTEGER NOT NULL CHECK (lifetime_minutes BETWEEN 1 AND 30),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,                     -- set when the upload completes
  download_limit INTEGER CHECK (download_limit IS NULL OR download_limit >= 1),
  download_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX files_owner_created ON files (owner_id, created_at);
CREATE INDEX files_state_expires ON files (state, expires_at);
CREATE INDEX files_state_created ON files (state, created_at);

CREATE TABLE file_shares (
  file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users (id),
  PRIMARY KEY (file_id, user_id)
);
CREATE INDEX file_shares_user ON file_shares (user_id);

CREATE TABLE upload_parts (
  file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK (part_number >= 1),
  etag TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL,
  PRIMARY KEY (file_id, part_number)
);

CREATE TABLE schools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pair', 'group')),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  created_by INTEGER NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL
);

CREATE TABLE school_members (
  school_id TEXT NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users (id),
  accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
  -- JSON array of session types taking part, e.g. ["chat","local_coding"]
  session_types TEXT NOT NULL DEFAULT '["chat","local_coding","hosted_coding","persistent_agent"]',
  PRIMARY KEY (school_id, user_id)
);
CREATE INDEX school_members_user ON school_members (user_id);

CREATE TABLE sessions (
  handle TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  type TEXT NOT NULL CHECK (type IN ('chat', 'local_coding', 'hosted_coding', 'persistent_agent')),
  product TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE (user_id, type, product, label)
);

CREATE TABLE read_positions (
  session_handle TEXT NOT NULL REFERENCES sessions (handle) ON DELETE CASCADE,
  school_id TEXT NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
  last_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_handle, school_id)
);

CREATE TABLE messages (
  school_id TEXT NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  sender_id INTEGER NOT NULL REFERENCES users (id),
  session_type TEXT NOT NULL,
  product TEXT NOT NULL,
  label TEXT NOT NULL,
  text TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]', -- JSON array of {file_id, key?}
  created_at INTEGER NOT NULL,
  PRIMARY KEY (school_id, seq)
);
CREATE INDEX messages_created ON messages (created_at);
