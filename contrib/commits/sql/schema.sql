-- contrib_commits database — declarative end-state schema (SOURCE OF TRUTH).
--
-- This contrib's OWN database (`contribs.commits.db`), owned by the broker's role
-- because the store runs inside the broker. Atlas writes ./migrations from this
-- file (`just db-migrate commits`). The row model in scooter_contrib_commits/store.py
-- mirrors it, and tests/test_db.py holds them together.

-- One commit identity per user; `set_by` is 'user' or 'agent'.
CREATE TABLE "commit_identities" (
  "user_id"    character varying NOT NULL,
  "name"       character varying NOT NULL,
  "email"      character varying NOT NULL,
  "set_by"     character varying NOT NULL,
  "updated_at" character varying NOT NULL,
  PRIMARY KEY ("user_id")
);

-- Unwritten; kept for decided rows, dropped next release.
CREATE TABLE "commit_identity_proposals" (
  "id"              character varying NOT NULL,
  "user_id"         character varying NOT NULL,
  "conversation_id" character varying NOT NULL,
  "name"            character varying NOT NULL,
  "email"           character varying NOT NULL,
  "status"          character varying NOT NULL,
  "created_at"      character varying NOT NULL,
  "decided_at"      character varying NULL,
  PRIMARY KEY ("id")
);
