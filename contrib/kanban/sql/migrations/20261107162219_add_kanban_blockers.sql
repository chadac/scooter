-- Create "kanban_blockers" table
CREATE TABLE "kanban_blockers" (
  "conversation_id" character varying NOT NULL,
  "blocker_id" character varying NOT NULL,
  "created_by" character varying NOT NULL,
  "created_at" character varying NOT NULL,
  PRIMARY KEY ("conversation_id", "blocker_id")
);
-- Create index "ix_kanban_blockers_blocker_id" to table: "kanban_blockers"
CREATE INDEX "ix_kanban_blockers_blocker_id" ON "kanban_blockers" ("blocker_id");
