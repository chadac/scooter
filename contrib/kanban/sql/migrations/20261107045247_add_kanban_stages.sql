-- Create "kanban_stages" table
CREATE TABLE "kanban_stages" (
  "folder_id" character varying NOT NULL,
  "board_id" character varying NOT NULL,
  "name" character varying NOT NULL,
  "position" double precision NOT NULL,
  PRIMARY KEY ("folder_id")
);
-- Create index "ix_kanban_stages_board_id" to table: "kanban_stages"
CREATE INDEX "ix_kanban_stages_board_id" ON "kanban_stages" ("board_id");
