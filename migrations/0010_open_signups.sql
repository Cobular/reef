-- Open signups (DESIGN.md "Signups" and "Deleting an account").

-- The daily new-account cap counts users created since 00:00 UTC: a range on this index.
CREATE INDEX users_created ON users (created_at);

-- Account deletion hands each school the account created to another member.
CREATE INDEX schools_created_by ON schools (created_by);

-- School invites sent per account per UTC day (`day` is floor(epoch ms / 86 400 000)). A counter
-- rather than columns on school_members: declining an invite deletes its row, and a school's
-- pending invites go with it when its last member leaves, so counting member rows would hand the
-- quota back. No foreign key, so deleting an account keeps its count until the day ends. The
-- cron job deletes rows from earlier days.
CREATE TABLE school_invites_sent (
  day INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  sent INTEGER NOT NULL,
  PRIMARY KEY (day, user_id)
) WITHOUT ROWID;
