-- Create index "conversations_by_parent" to table: "conversations"
CREATE INDEX "conversations_by_parent" ON "conversations" ("parent_id");
-- Create "conversation_authors" table
CREATE TABLE "conversation_authors" (
  "conversation_id" text NOT NULL,
  "kind" text NOT NULL,
  "author" text NOT NULL,
  "first_at" bigint NOT NULL,
  PRIMARY KEY ("conversation_id", "kind", "author"),
  CONSTRAINT "conversation_authors_kind_check" CHECK (kind = ANY (ARRAY['identity'::text, 'user'::text, 'unknown'::text]))
);
-- Taint existing conversations holding text relayed from outside the owner.
INSERT INTO "conversation_authors" ("conversation_id", "kind", "author", "first_at")
SELECT DISTINCT "conversation_id", 'unknown', '', (extract(epoch FROM now()) * 1000)::bigint
FROM "conversation_events"
WHERE "event"->>'type' = 'SYSTEM_MESSAGE'
  AND COALESCE("event"->>'source', '') NOT IN (
    'hook', 'resume', 'startup', 'system', 'scheduler', 'files', 'ui',
    'subagent', 'background job', 'parent-clarification'
  )
ON CONFLICT DO NOTHING;
