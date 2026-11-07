-- Drop index "conversation_folders_name" from table: "conversation_folders"
DROP INDEX "conversation_folders_name";
-- Modify "conversation_folders" table
ALTER TABLE "conversation_folders" ADD CONSTRAINT "conversation_folders_conversation_lifetime_hours_check" CHECK (conversation_lifetime_hours >= 0), ADD COLUMN "locked" boolean NOT NULL DEFAULT false, ADD COLUMN "parent_id" text NULL, ADD COLUMN "conversation_lifetime_hours" integer NULL, ADD
CONSTRAINT "conversation_folders_parent" FOREIGN KEY ("parent_id") REFERENCES "conversation_folders" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
-- Create index "conversation_folders_name" to table: "conversation_folders"
CREATE UNIQUE INDEX "conversation_folders_name" ON "conversation_folders" ("owner", (COALESCE(parent_id, ''::text)), (lower(name))) WHERE (kind = 'user'::text);
-- Create index "conversation_folders_by_parent" to table: "conversation_folders"
CREATE INDEX "conversation_folders_by_parent" ON "conversation_folders" ("parent_id");
