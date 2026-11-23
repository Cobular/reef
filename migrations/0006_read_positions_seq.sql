-- insertMessage allocates a seq above the highest read position in the school (so a school
-- emptied by retention never reuses seqs). With (school_id, last_seq) that MAX is one index seek
-- instead of a scan of every read position in the school. It also serves every lookup the
-- school_id-only index did, so that one goes.
CREATE INDEX read_positions_school_seq ON read_positions (school_id, last_seq);
DROP INDEX read_positions_school;
