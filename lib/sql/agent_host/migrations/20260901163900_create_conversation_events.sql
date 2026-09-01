-- Create "conversation_events" table
CREATE TABLE "conversation_events" (
  "conversation_id" text NOT NULL,
  "seq" bigint NOT NULL,
  "event" jsonb NOT NULL,
  "checksum" text NOT NULL,
  "prev_checksum" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("conversation_id", "seq")
);
