-- Create "skill_sources" table
CREATE TABLE "skill_sources" (
  "id" character varying NOT NULL,
  "owner" character varying NOT NULL,
  "kind" character varying NOT NULL,
  "spec" character varying NOT NULL,
  "skills" text NOT NULL,
  "enabled" boolean NOT NULL,
  "created_at" character varying NOT NULL,
  "updated_at" character varying NOT NULL,
  PRIMARY KEY ("id")
);
-- Create index "ix_skill_sources_owner" to table: "skill_sources"
CREATE INDEX "ix_skill_sources_owner" ON "skill_sources" ("owner");
-- Create index "skill_sources_owner_kind_spec" to table: "skill_sources"
CREATE UNIQUE INDEX "skill_sources_owner_kind_spec" ON "skill_sources" ("owner", "kind", "spec");
