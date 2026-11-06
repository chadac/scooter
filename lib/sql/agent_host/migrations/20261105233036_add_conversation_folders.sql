-- Create "conversation_folders" table
CREATE TABLE "conversation_folders" (
  "id" text NOT NULL,
  "owner" text NOT NULL,
  "kind" text NOT NULL DEFAULT 'user',
  "name" text NOT NULL,
  "position" double precision NOT NULL,
  "created_at" bigint NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "conversation_folders_kind_check" CHECK (kind = ANY (ARRAY['starred'::text, 'user'::text])),
  CONSTRAINT "conversation_folders_name_check" CHECK ((length(name) >= 1) AND (length(name) <= 100))
);
-- Create index "conversation_folders_name" to table: "conversation_folders"
CREATE UNIQUE INDEX "conversation_folders_name" ON "conversation_folders" ("owner", (lower(name))) WHERE (kind = 'user'::text);
-- Create index "conversation_folders_one_starred" to table: "conversation_folders"
CREATE UNIQUE INDEX "conversation_folders_one_starred" ON "conversation_folders" ("owner") WHERE (kind = 'starred'::text);
-- Create "user_conversation_metadata" table
CREATE TABLE "user_conversation_metadata" (
  "owner" text NOT NULL,
  "conversation_id" text NOT NULL,
  "folder_id" text NOT NULL,
  PRIMARY KEY ("owner", "conversation_id"),
  CONSTRAINT "user_conversation_metadata_conversation" FOREIGN KEY ("conversation_id") REFERENCES "conversations" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "user_conversation_metadata_folder" FOREIGN KEY ("folder_id") REFERENCES "conversation_folders" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "user_conversation_metadata_by_folder" to table: "user_conversation_metadata"
CREATE INDEX "user_conversation_metadata_by_folder" ON "user_conversation_metadata" ("folder_id");
