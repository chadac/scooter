-- Modify "conversations" table
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_kind_check" CHECK (kind = ANY (ARRAY['subagent'::text, 'session'::text])), ADD COLUMN "kind" text NULL;
-- Existing children are all agent-spawned subagents.
UPDATE "conversations" SET "kind" = 'subagent' WHERE "parent_id" IS NOT NULL;
