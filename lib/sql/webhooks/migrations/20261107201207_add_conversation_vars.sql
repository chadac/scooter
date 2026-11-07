-- Create "conversation_vars" table
CREATE TABLE "conversation_vars" (
  "conversation_id" character varying NOT NULL,
  "namespace" character varying NOT NULL,
  "key" character varying NOT NULL,
  "value" jsonb NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("conversation_id", "namespace", "key")
);
