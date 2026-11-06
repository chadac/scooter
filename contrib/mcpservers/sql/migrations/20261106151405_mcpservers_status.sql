-- Create "mcp_server_status" table
CREATE TABLE "mcp_server_status" (
  "conversation_id" character varying NOT NULL,
  "report" text NOT NULL,
  "reported_at" character varying NOT NULL,
  PRIMARY KEY ("conversation_id")
);
