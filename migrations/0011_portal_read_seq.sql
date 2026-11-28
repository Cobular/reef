-- The person's own read position in each school, moved when they view the newest messages in the
-- portal. Until now the portal's unread badge only cleared when one of the account's agent
-- sessions read with school_read, so a school no session of the account reads (or a person's own
-- portal message) left the badge up for good. Sessions keep their own positions in
-- read_positions; this one never changes what a session sees as unread.
ALTER TABLE school_members ADD COLUMN portal_read_seq INTEGER NOT NULL DEFAULT 0;
