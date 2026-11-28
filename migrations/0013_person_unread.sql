-- The portal's unread count becomes the person's own tracker: messages after portal_read_seq,
-- whatever the account's agent sessions have read (until now it used the furthest of the two).
-- Carry over what each person sees today, so the switch doesn't show a month of messages as new.
UPDATE school_members SET portal_read_seq = MAX(portal_read_seq, COALESCE(
  (SELECT MAX(rp.last_seq) FROM read_positions rp
   JOIN sessions s ON s.handle = rp.session_handle
   WHERE rp.school_id = school_members.school_id AND s.user_id = school_members.user_id), 0))
WHERE accepted = 1;
