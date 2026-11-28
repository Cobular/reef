-- Display names (DESIGN.md "Display names"). An account may choose a name that Reef shows in
-- place of its GitHub login: in school envelopes and member lists, share lists and the portal.
-- Tools and the portal accept it wherever they take an account. Unique without regard to case;
-- the rule that it may not equal another account's login is enforced by the service (and a new
-- or renamed login takes precedence, clearing a display name equal to it).
ALTER TABLE users ADD COLUMN display_name TEXT;
CREATE UNIQUE INDEX users_display_name ON users (display_name COLLATE NOCASE)
  WHERE display_name IS NOT NULL;
