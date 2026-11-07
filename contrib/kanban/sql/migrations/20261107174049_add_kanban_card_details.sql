-- Create "kanban_card_details" table
CREATE TABLE "kanban_card_details" (
  "conversation_id" character varying NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "priority" integer NOT NULL DEFAULT 0,
  "updated_by" character varying NOT NULL,
  "updated_at" character varying NOT NULL,
  PRIMARY KEY ("conversation_id")
);
