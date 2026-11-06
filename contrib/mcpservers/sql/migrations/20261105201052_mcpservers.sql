-- Create "mcp_servers" table
CREATE TABLE "mcp_servers" (
  "id" character varying NOT NULL,
  "owner" character varying NOT NULL,
  "name" character varying NOT NULL,
  "kind" character varying NOT NULL,
  "spec" character varying NOT NULL,
  "args" text NOT NULL,
  "enabled" boolean NOT NULL,
  "created_at" character varying NOT NULL,
  "updated_at" character varying NOT NULL,
  PRIMARY KEY ("id")
);
-- Create index "ix_mcp_servers_owner" to table: "mcp_servers"
CREATE INDEX "ix_mcp_servers_owner" ON "mcp_servers" ("owner");
-- Create index "mcp_servers_owner_name" to table: "mcp_servers"
CREATE UNIQUE INDEX "mcp_servers_owner_name" ON "mcp_servers" ("owner", "name");
