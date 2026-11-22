-- Schools v1: indexes for the per-account message rate limit and the cleanup cron.

-- Rate limit: messages one account sent in the last minute.
CREATE INDEX messages_sender_created ON messages (sender_id, created_at);

-- Cleanup: only messages that still carry an attachment key. The expression must match the
-- one in src/schools/cleanup.ts exactly for the planner to use this partial index.
CREATE INDEX messages_keyed ON messages (created_at) WHERE instr(attachments, '"key"') > 0;

-- Cleanup: sessions not seen for 90 days.
-- (Lookups by account use the UNIQUE (user_id, type, product, label) index from 0001.)
CREATE INDEX sessions_last_seen ON sessions (last_seen_at);
