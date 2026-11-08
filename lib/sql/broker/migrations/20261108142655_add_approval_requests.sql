-- Create "approval_requests" table
CREATE TABLE "approval_requests" (
  "id" character varying NOT NULL,
  "contrib" character varying NOT NULL,
  "conversation_id" character varying NOT NULL,
  "owner" character varying NOT NULL,
  "payload" text NOT NULL,
  "status" character varying NOT NULL,
  "decided_by" character varying NULL,
  "created_at" bigint NOT NULL,
  "decided_at" bigint NULL,
  "expires_at" bigint NULL,
  PRIMARY KEY ("id")
);
-- Create index "ix_approval_requests_conversation" to table: "approval_requests"
CREATE INDEX "ix_approval_requests_conversation" ON "approval_requests" ("contrib", "conversation_id", "status");
-- Create index "ix_approval_requests_owner" to table: "approval_requests"
CREATE INDEX "ix_approval_requests_owner" ON "approval_requests" ("contrib", "owner", "status");
