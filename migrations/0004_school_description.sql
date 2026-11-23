-- A school's purpose, written by its members, so people and agents can tell which to join.
ALTER TABLE schools ADD COLUMN description TEXT NOT NULL DEFAULT '';
