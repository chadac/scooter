-- Create "static_folders" table
CREATE TABLE "static_folders" (
  "id" text NOT NULL,
  "service_account" text NOT NULL,
  "name" text NOT NULL,
  "icon" text NULL,
  "conversation_lifetime_hours" integer NULL,
  "created_at" bigint NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "static_folders_conversation_lifetime_hours_check" CHECK (conversation_lifetime_hours >= 0),
  CONSTRAINT "static_folders_icon_check" CHECK (icon ~ '^[a-z0-9-]{1,40}$'::text),
  CONSTRAINT "static_folders_id_check" CHECK (id ~ '^[a-z][a-z0-9-]{0,62}$'::text),
  CONSTRAINT "static_folders_name_check" CHECK ((length(name) >= 1) AND (length(name) <= 100))
);
-- Drop index "conversation_folders_name" from table: "conversation_folders"
DROP INDEX "conversation_folders_name";
-- Modify "conversation_folders" table
ALTER TABLE "conversation_folders" DROP CONSTRAINT "conversation_folders_kind_check", ADD CONSTRAINT "conversation_folders_kind_check" CHECK (kind = ANY (ARRAY['starred'::text, 'static'::text, 'user'::text])), ADD CONSTRAINT "conversation_folders_conversation_lifetime_hours_check" CHECK (conversation_lifetime_hours >= 0), ADD CONSTRAINT "conversation_folders_static_id" CHECK ((kind = 'static'::text) = (static_id IS NOT NULL)), ADD COLUMN "static_id" text NULL, ADD COLUMN "parent_id" text NULL, ADD COLUMN "conversation_lifetime_hours" integer NULL, ADD
CONSTRAINT "conversation_folders_parent" FOREIGN KEY ("parent_id") REFERENCES "conversation_folders" ("id") ON UPDATE NO ACTION ON DELETE CASCADE, ADD
CONSTRAINT "conversation_folders_static_folder" FOREIGN KEY ("static_id") REFERENCES "static_folders" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
-- Create index "conversation_folders_name" to table: "conversation_folders"
CREATE UNIQUE INDEX "conversation_folders_name" ON "conversation_folders" ("owner", (COALESCE(parent_id, ''::text)), (lower(name))) WHERE (kind = 'user'::text);
-- Create index "conversation_folders_by_parent" to table: "conversation_folders"
CREATE INDEX "conversation_folders_by_parent" ON "conversation_folders" ("parent_id");
-- Create index "conversation_folders_static" to table: "conversation_folders"
CREATE UNIQUE INDEX "conversation_folders_static" ON "conversation_folders" ("static_id", "owner") WHERE (kind = 'static'::text);
