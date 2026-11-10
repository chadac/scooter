-- Create "kanban_gate_results" table
CREATE TABLE "kanban_gate_results" (
  "conversation_id" character varying NOT NULL,
  "gate_id" character varying NOT NULL,
  "state" character varying NOT NULL,
  "detail" text NOT NULL DEFAULT '',
  "commit" character varying NOT NULL DEFAULT '',
  "updated_by" character varying NOT NULL,
  "updated_at" character varying NOT NULL,
  PRIMARY KEY ("conversation_id", "gate_id")
);
-- Create index "ix_kanban_gate_results_gate_id" to table: "kanban_gate_results"
CREATE INDEX "ix_kanban_gate_results_gate_id" ON "kanban_gate_results" ("gate_id");
-- Create "kanban_gates" table
CREATE TABLE "kanban_gates" (
  "id" character varying NOT NULL,
  "board_id" character varying NOT NULL,
  "stage_id" character varying NOT NULL,
  "kind" character varying NOT NULL,
  "name" character varying NOT NULL,
  "command" text NOT NULL DEFAULT '',
  "workdir" character varying NOT NULL DEFAULT '',
  "clean" boolean NOT NULL DEFAULT true,
  "timeout_seconds" integer NOT NULL DEFAULT 600,
  "position" double precision NOT NULL,
  PRIMARY KEY ("id")
);
-- Create index "ix_kanban_gates_board_id" to table: "kanban_gates"
CREATE INDEX "ix_kanban_gates_board_id" ON "kanban_gates" ("board_id");
