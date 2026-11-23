-- Performance: read positions by school.
-- Used by the portal's per-school read_seq lookup and by the ON DELETE CASCADE from schools,
-- which otherwise scans every read position in the service when a school is deleted.
CREATE INDEX read_positions_school ON read_positions (school_id);
