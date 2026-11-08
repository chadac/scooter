-- Create "k8s_grants" table
CREATE TABLE "k8s_grants" (
  "id" character varying NOT NULL,
  "conversation_id" character varying NOT NULL,
  "cluster" character varying NOT NULL,
  "namespace" character varying NOT NULL,
  "approved_by" character varying NOT NULL,
  "request_id" character varying NOT NULL,
  "created_at" bigint NOT NULL,
  "expires_at" bigint NOT NULL,
  PRIMARY KEY ("id")
);
-- Create index "ix_k8s_grants_conversation_id" to table: "k8s_grants"
CREATE INDEX "ix_k8s_grants_conversation_id" ON "k8s_grants" ("conversation_id");
