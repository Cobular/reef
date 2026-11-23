-- A message may say which earlier message in the same school it answers: that message's seq.
-- Not a foreign key: retention deletes old messages, and a reply outlives its parent.
ALTER TABLE messages ADD COLUMN reply_to INTEGER;
