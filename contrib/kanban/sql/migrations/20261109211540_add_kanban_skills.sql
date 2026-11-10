-- Create "kanban_skills" table
CREATE TABLE "kanban_skills" (
  "id" character varying NOT NULL,
  "board_id" character varying NOT NULL,
  "name" character varying NOT NULL,
  "body" text NOT NULL,
  "position" double precision NOT NULL,
  PRIMARY KEY ("id")
);
-- Create index "ix_kanban_skills_board_id" to table: "kanban_skills"
CREATE INDEX "ix_kanban_skills_board_id" ON "kanban_skills" ("board_id");
