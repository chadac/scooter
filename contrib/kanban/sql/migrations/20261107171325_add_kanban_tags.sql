-- Create "kanban_card_tags" table
CREATE TABLE "kanban_card_tags" (
  "conversation_id" character varying NOT NULL,
  "tag_id" character varying NOT NULL,
  PRIMARY KEY ("conversation_id", "tag_id")
);
-- Create index "ix_kanban_card_tags_tag_id" to table: "kanban_card_tags"
CREATE INDEX "ix_kanban_card_tags_tag_id" ON "kanban_card_tags" ("tag_id");
-- Create "kanban_tags" table
CREATE TABLE "kanban_tags" (
  "id" character varying NOT NULL,
  "board_id" character varying NOT NULL,
  "name" character varying NOT NULL,
  "color" character varying NOT NULL,
  "position" double precision NOT NULL,
  PRIMARY KEY ("id")
);
-- Create index "ix_kanban_tags_board_id" to table: "kanban_tags"
CREATE INDEX "ix_kanban_tags_board_id" ON "kanban_tags" ("board_id");
