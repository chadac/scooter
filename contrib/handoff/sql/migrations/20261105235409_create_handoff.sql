-- Create "handoff_conversations" table
CREATE TABLE "handoff_conversations" (
  "conversation_id" character varying NOT NULL,
  "title" text NOT NULL,
  "owner" character varying NULL,
  "last_activity_at" bigint NOT NULL,
  PRIMARY KEY ("conversation_id")
);
-- Create "handoff_messages" table
CREATE TABLE "handoff_messages" (
  "conversation_id" character varying NOT NULL,
  "seq" integer NOT NULL,
  "role" character varying NOT NULL,
  "text" text NOT NULL,
  PRIMARY KEY ("conversation_id", "seq")
);
-- Create index "ix_handoff_messages_fts" to table: "handoff_messages"
CREATE INDEX "ix_handoff_messages_fts" ON "handoff_messages" USING gin ((to_tsvector('english'::regconfig, text)));
-- Create "handoff_spawn_requests" table
CREATE TABLE "handoff_spawn_requests" (
  "id" character varying NOT NULL,
  "conversation_id" character varying NOT NULL,
  "owner" character varying NOT NULL,
  "brief" text NOT NULL,
  "title" text NOT NULL,
  "model" character varying NOT NULL,
  "status" character varying NOT NULL,
  "spawned_id" character varying NULL,
  "created_at" bigint NOT NULL,
  "decided_at" bigint NULL,
  PRIMARY KEY ("id")
);
-- Create index "ix_handoff_spawn_requests_pending" to table: "handoff_spawn_requests"
CREATE INDEX "ix_handoff_spawn_requests_pending" ON "handoff_spawn_requests" ("conversation_id", "status");
