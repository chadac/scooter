-- Create "static_share_versions" table
CREATE TABLE "static_share_versions" (
  "id" serial NOT NULL,
  "share_uuid" character varying NOT NULL,
  "version" integer NOT NULL,
  "entry_point" character varying NOT NULL,
  "files_json" text NOT NULL,
  "created_at" character varying NOT NULL,
  PRIMARY KEY ("id")
);
-- Create index "ix_static_share_versions_share_uuid" to table: "static_share_versions"
CREATE INDEX "ix_static_share_versions_share_uuid" ON "static_share_versions" ("share_uuid");
-- Create "static_shares" table
CREATE TABLE "static_shares" (
  "uuid" character varying NOT NULL,
  "owner" character varying NOT NULL,
  "conversation_id" character varying NOT NULL,
  "description" text NOT NULL,
  "visibility" character varying NOT NULL,
  "latest_version" integer NOT NULL,
  "created_at" character varying NOT NULL,
  "updated_at" character varying NOT NULL,
  PRIMARY KEY ("uuid")
);
-- Create index "ix_static_shares_conversation_id" to table: "static_shares"
CREATE INDEX "ix_static_shares_conversation_id" ON "static_shares" ("conversation_id");
-- Create index "ix_static_shares_owner" to table: "static_shares"
CREATE INDEX "ix_static_shares_owner" ON "static_shares" ("owner");
-- Create index "ix_static_shares_visibility" to table: "static_shares"
CREATE INDEX "ix_static_shares_visibility" ON "static_shares" ("visibility");
