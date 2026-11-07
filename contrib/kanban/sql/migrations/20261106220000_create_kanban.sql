-- Create "kanban_cards" table
CREATE TABLE "kanban_cards" (
  "conversation_id" character varying NOT NULL,
  "column_id" character varying NOT NULL,
  "position" double precision NOT NULL,
  "note" text NOT NULL,
  "updated_by" character varying NOT NULL,
  "updated_at" character varying NOT NULL,
  PRIMARY KEY ("conversation_id")
);
-- Create "kanban_boards" table
CREATE TABLE "kanban_boards" (
  "folder_id" character varying NOT NULL,
  "owner" character varying NOT NULL,
  "created_at" character varying NOT NULL,
  PRIMARY KEY ("folder_id")
);
-- Create index "ix_kanban_boards_owner" to table: "kanban_boards"
CREATE INDEX "ix_kanban_boards_owner" ON "kanban_boards" ("owner");
