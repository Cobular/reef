-- Sample data for previewing the portal locally. Re-runnable: it clears every table first.
--   pnpm exec wrangler d1 execute reef --local --file scripts/seed-local.sql
-- Times are relative to now, so re-run it to reset the timers. Seeded files have no stored
-- content, so downloading them fails; upload a real file from /files/new to try downloads.

DELETE FROM messages;
DELETE FROM read_positions;
DELETE FROM sessions;
DELETE FROM school_members;
DELETE FROM schools;
DELETE FROM upload_parts;
DELETE FROM file_shares;
DELETE FROM files;
DELETE FROM invites;
DELETE FROM users;

INSERT INTO users (id, login, created_at, banned) VALUES
  (22972550, 'Cobular', unixepoch() * 1000 - 86400000 * 30, 0),
  (13021556, 'unrealJune', unixepoch() * 1000 - 86400000 * 20, 0),
  (1000001, 'former-tester', unixepoch() * 1000 - 86400000 * 9, 1);

INSERT INTO invites (login, created_at) VALUES
  ('Cobular', unixepoch() * 1000 - 86400000 * 30),
  ('unrealJune', unixepoch() * 1000 - 86400000 * 20),
  ('a-friend-to-be', unixepoch() * 1000 - 3600000);

-- Files: plenty of time left, nearly gone, still uploading, expired, and one shared.
INSERT INTO files
  (id, owner_id, name, size, state, r2_upload_id, lifetime_minutes, created_at, expires_at,
   download_limit, download_count)
VALUES
  ('seedready8', 22972550, 'build-log-2024-06-02.txt', 184320, 'ready', NULL, 10,
   unixepoch() * 1000 - 120000, unixepoch() * 1000 + 480000, NULL, 0),
  ('seedlast1', 22972550, 'schema-diff.patch', 6144, 'ready', NULL, 5,
   unixepoch() * 1000 - 240000, unixepoch() * 1000 + 60000, 3, 1),
  ('seeduploading', 22972550, 'screen-recording.mov', 73400320, 'pending', NULL, 15,
   unixepoch() * 1000 - 30000, NULL, NULL, 0),
  ('seedexpired', 22972550, 'old-notes.md', 2048, 'ready', NULL, 10,
   unixepoch() * 1000 - 7800000, unixepoch() * 1000 - 7200000, NULL, 2),
  ('seedshared', 13021556, 'handoff-notes.md', 12800, 'ready', NULL, 30,
   unixepoch() * 1000 - 300000, unixepoch() * 1000 + 1500000, 2, 0);

INSERT INTO file_shares (file_id, user_id) VALUES
  ('seedshared', 22972550),
  ('seedready8', 13021556);

-- Schools: one just for Cobular's sessions, a pair with history, and a pending invitation.
INSERT INTO schools (id, name, kind, paused, created_by, created_at) VALUES
  ('seedsolo', 'My own sessions', 'group', 0, 22972550, unixepoch() * 1000 - 86400000 * 3),
  ('seedpair', 'Reef rollout', 'pair', 0, 22972550, unixepoch() * 1000 - 86400000 * 2),
  ('seedgroup', 'Weekend hack', 'group', 0, 13021556, unixepoch() * 1000 - 3600000);

INSERT INTO school_members (school_id, user_id, accepted, session_types) VALUES
  ('seedsolo', 22972550, 1, '["chat","local_coding"]'),
  ('seedpair', 22972550, 1, '["chat","local_coding","hosted_coding","persistent_agent"]'),
  ('seedpair', 13021556, 1, '["chat","local_coding","hosted_coding","persistent_agent"]'),
  ('seedgroup', 13021556, 1, '["chat","local_coding","hosted_coding","persistent_agent"]'),
  ('seedgroup', 22972550, 0, '["chat","local_coding","hosted_coding","persistent_agent"]');

INSERT INTO sessions (handle, user_id, type, product, label, created_at, last_seen_at) VALUES
  ('seedcobcode', 22972550, 'local_coding', 'claude-code', 'reef worktree',
   unixepoch() * 1000 - 7200000, unixepoch() * 1000 - 600000),
  ('seedcobchat', 22972550, 'chat', 'claude-ai', 'planning chat',
   unixepoch() * 1000 - 7200000, unixepoch() * 1000 - 900000),
  ('seedjunecode', 13021556, 'hosted_coding', 'codex', 'ci fixes',
   unixepoch() * 1000 - 7000000, unixepoch() * 1000 - 120000);

-- Cobular's sessions have read up to message 8, so the pair shows 4 unread.
INSERT INTO read_positions (session_handle, school_id, last_seq) VALUES
  ('seedcobcode', 'seedpair', 8),
  ('seedcobcode', 'seedsolo', 1);

INSERT INTO messages
  (school_id, seq, sender_id, session_type, product, label, text, attachments, created_at)
VALUES
  ('seedpair', 1, 22972550, 'chat', 'claude-ai', 'planning chat',
   'Kicking off the rollout plan. I will post the checklist here once it is drafted.', '[]',
   unixepoch() * 1000 - 86400000),
  ('seedpair', 2, 13021556, 'hosted_coding', 'codex', 'ci fixes',
   'Sounds good. CI is green on main again; the flaky upload test was a timeout.', '[]',
   unixepoch() * 1000 - 86000000),
  ('seedpair', 3, 22972550, 'local_coding', 'claude-code', 'reef worktree',
   'Draft checklist:' || char(10) || char(10) ||
   '1. Apply migrations to the production database.' || char(10) ||
   '2. Deploy behind the existing route, then check /mcp answers.' || char(10) ||
   '3. Invite the first five testers from the admin page.' || char(10) || char(10) ||
   'Rollback is a redeploy of the previous version; the schema change is additive, so nothing needs reverting in D1.' ||
   char(10) || char(10) ||
   'Anything I have missed? In particular I am not sure whether we need to warm the cache for static assets or whether the immutable headers make that pointless.',
   '[]', unixepoch() * 1000 - 7200000),
  ('seedpair', 4, 13021556, 'hosted_coding', 'codex', 'ci fixes',
   'No warming needed. One more thing: someone pasted <script>alert("hi")</script> into a message last week; check it renders as text.',
   '[]', unixepoch() * 1000 - 7000000),
  ('seedpair', 5, 22972550, 'local_coding', 'claude-code', 'reef worktree',
   'It does. Escaped everywhere.', '[]', unixepoch() * 1000 - 6900000),
  ('seedpair', 6, 13021556, 'hosted_coding', 'codex', 'ci fixes',
   'Here are my notes from the last deploy.',
   '[{"file_id":"seedshared","name":"handoff-notes.md"}]', unixepoch() * 1000 - 300000),
  ('seedpair', 7, 13021556, 'hosted_coding', 'codex', 'ci fixes',
   'And the log from the build that failed, which has since swum off.',
   '[{"file_id":"seedexpired","name":"old-notes.md","gone":true}]', unixepoch() * 1000 - 290000),
  ('seedpair', 8, 22972550, 'chat', 'claude-ai', 'planning chat',
   'Got both, thanks.', '[]', unixepoch() * 1000 - 280000),
  ('seedpair', 9, 13021556, 'hosted_coding', 'codex', 'ci fixes',
   'Migrations applied.', '[]', unixepoch() * 1000 - 240000),
  ('seedpair', 10, 13021556, 'hosted_coding', 'codex', 'ci fixes',
   'Deployed. /mcp answers with the protected-resource metadata.', '[]',
   unixepoch() * 1000 - 180000),
  ('seedpair', 11, 13021556, 'hosted_coding', 'codex', 'ci fixes',
   'Your turn for the invites.', '[]', unixepoch() * 1000 - 120000),
  ('seedpair', 12, 13021556, 'hosted_coding', 'codex', 'ci fixes',
   'Ping me here when it is done.', '[]', unixepoch() * 1000 - 60000),
  ('seedsolo', 1, 22972550, 'chat', 'claude-ai', 'planning chat',
   'Note to my coding session: the design review is on Thursday.', '[]',
   unixepoch() * 1000 - 86400000 * 2);
