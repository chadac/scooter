-- Create "conversation_trusted_authors" table
CREATE TABLE "conversation_trusted_authors" (
  "conversation_id" text NOT NULL,
  "source" text NOT NULL,
  "author" text NOT NULL,
  "allowed_by" text NOT NULL,
  "created_at" bigint NOT NULL,
  PRIMARY KEY ("conversation_id", "source", "author")
);
-- Create "held_messages" table
CREATE TABLE "held_messages" (
  "id" text NOT NULL,
  "conversation_id" text NOT NULL,
  "source" text NOT NULL,
  "author" text NOT NULL,
  "url" text NOT NULL,
  "prompt" text NOT NULL,
  "text" text NOT NULL,
  "created_at" bigint NOT NULL,
  PRIMARY KEY ("id")
);
-- Create index "held_messages_by_conv" to table: "held_messages"
CREATE INDEX "held_messages_by_conv" ON "held_messages" ("conversation_id", "created_at");
