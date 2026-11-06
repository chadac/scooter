-- contrib_mcpservers database — declarative end-state schema (SOURCE OF TRUTH).
--
-- This contrib's OWN database (`contribs.mcpservers.db`), owned by the broker's role
-- because the store runs inside the broker. Atlas writes ./migrations from this
-- file (`just db-migrate mcpservers`). The row model in
-- scooter_contrib_mcpservers/store.py mirrors it, and tests/test_db.py holds them together.

-- An MCP server a user's sandboxes start: an npm, PyPI or nixpkgs package.
CREATE TABLE "mcp_servers" (
  "id"         character varying NOT NULL,
  "owner"      character varying NOT NULL,
  "name"       character varying NOT NULL,
  "kind"       character varying NOT NULL,
  "spec"       character varying NOT NULL,
  "args"       text NOT NULL, -- JSON array of argv strings
  "enabled"    boolean NOT NULL,
  "created_at" character varying NOT NULL,
  "updated_at" character varying NOT NULL,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_mcp_servers_owner" ON "mcp_servers" ("owner");
CREATE UNIQUE INDEX "mcp_servers_owner_name" ON "mcp_servers" ("owner", "name");

-- The last state a conversation's sandbox reported for its servers, one row each.
CREATE TABLE "mcp_server_status" (
  "conversation_id" character varying NOT NULL,
  "report"          text NOT NULL, -- JSON {servers: [{name, state}], error}
  "reported_at"     character varying NOT NULL,
  PRIMARY KEY ("conversation_id")
);
