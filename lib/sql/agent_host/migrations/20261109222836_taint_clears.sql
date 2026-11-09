-- Modify "conversation_authors" table; existing rows last wrote when they first did.
ALTER TABLE "conversation_authors" ADD COLUMN "last_at" bigint NULL;
UPDATE "conversation_authors" SET "last_at" = "first_at";
ALTER TABLE "conversation_authors" ALTER COLUMN "last_at" SET NOT NULL;
-- Create "conversation_author_clears" table
CREATE TABLE "conversation_author_clears" (
  "id" bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
  "conversation_id" text NOT NULL,
  "kind" text NOT NULL,
  "author" text NOT NULL,
  "first_at" bigint NOT NULL,
  "last_at" bigint NOT NULL,
  "cleared_at" bigint NOT NULL,
  "cleared_by" text NOT NULL,
  "via" text NOT NULL,
  "reason" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "conversation_author_clears_via_check" CHECK (via = ANY (ARRAY['ui'::text, 'agent'::text]))
);
-- Create index "conversation_author_clears_by_conversation" to table: "conversation_author_clears"
CREATE INDEX "conversation_author_clears_by_conversation" ON "conversation_author_clears" ("conversation_id");
