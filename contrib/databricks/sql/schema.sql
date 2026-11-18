-- contrib_databricks schema, the source of truth: `just db-migrate databricks` writes ./migrations.

-- `level` is 'read' (GET/HEAD) or 'read-write'; a NULL `expires_at` lasts until revoked.
CREATE TABLE "databricks_grants" (
  "id"              character varying NOT NULL,
  "conversation_id" character varying NOT NULL,
  "workspace"       character varying NOT NULL,
  "level"           character varying NOT NULL,
  "approved_by"     character varying NOT NULL,
  "request_id"      character varying NOT NULL,
  "created_at"      bigint NOT NULL,
  "expires_at"      bigint NULL,
  "revoked_at"      bigint NULL,
  "revoked_by"      character varying NULL,
  "parent_id"       character varying NULL,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_databricks_grants_conversation_id" ON "databricks_grants" ("conversation_id");
