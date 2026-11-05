-- contrib_skills database — declarative end-state schema (SOURCE OF TRUTH).
--
-- This contrib's OWN database (`contribs.skills.db`), owned by the broker's role
-- because the store runs inside the broker. Atlas writes ./migrations from this
-- file (`just db-migrate skills`). The row model in scooter_contrib_skills/store.py
-- mirrors it, and tests/test_db.py holds them together.

-- A skills.sh package or GitHub repo a user's sandboxes install.
CREATE TABLE "skill_sources" (
  "id"         character varying NOT NULL,
  "owner"      character varying NOT NULL,
  "kind"       character varying NOT NULL,
  "spec"       character varying NOT NULL,
  "skills"     text NOT NULL, -- comma-separated filter; empty is all
  "enabled"    boolean NOT NULL,
  "created_at" character varying NOT NULL,
  "updated_at" character varying NOT NULL,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_skill_sources_owner" ON "skill_sources" ("owner");
CREATE UNIQUE INDEX "skill_sources_owner_kind_spec" ON "skill_sources" ("owner", "kind", "spec");
