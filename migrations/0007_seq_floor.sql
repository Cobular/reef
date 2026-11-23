-- insertMessage allocates one above the larger of a school's newest seq and its seq_floor. The
-- retention cron raises seq_floor to the newest seq it deletes when it empties a school, so seqs
-- never go back below a position a session has already read past. This replaces reading the
-- highest read position on every send.
ALTER TABLE schools ADD COLUMN seq_floor INTEGER NOT NULL DEFAULT 0;

-- Until now the floor came from read positions: carry it over, so a school that retention has
-- already emptied keeps numbering above its sessions' positions.
UPDATE schools SET seq_floor = COALESCE(
  (SELECT MAX(last_seq) FROM read_positions WHERE school_id = schools.id), 0);
