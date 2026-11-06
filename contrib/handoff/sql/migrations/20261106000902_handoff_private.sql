-- Modify "handoff_conversations" table
ALTER TABLE "handoff_conversations" ADD COLUMN "visibility" character varying NOT NULL DEFAULT 'shared';
-- Create index "ix_handoff_conversations_owner" to table: "handoff_conversations"
CREATE INDEX "ix_handoff_conversations_owner" ON "handoff_conversations" ("owner");
