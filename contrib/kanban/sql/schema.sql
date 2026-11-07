-- contrib_kanban database — declarative end-state schema (SOURCE OF TRUTH).
--
-- This contrib's OWN database (`contribs.kanban.db`), owned by the broker's role
-- because the store runs inside the broker. Atlas writes ./migrations from this
-- file (`just db-migrate kanban`). The row model in scooter_contrib_kanban/store.py
-- mirrors it, and tests/test_db.py holds the two together.

-- One conversation's place on a board. A conversation with no row is in the first column.
CREATE TABLE "kanban_cards" (
  -- The broker's key for the conversation (Identity.conversation_id).
  "conversation_id" character varying NOT NULL,
  "column_id"       character varying NOT NULL,
  -- Fractional order within the column, so a move rewrites one row.
  "position"        double precision NOT NULL,
  -- The agent's one-line summary of where the work stands.
  "note"            text NOT NULL,
  -- "agent" or "user": who made the last change.
  "updated_by"      character varying NOT NULL,
  -- ISO-8601, like the other broker tables.
  "updated_at"      character varying NOT NULL,
  PRIMARY KEY ("conversation_id")
);

-- The folders a user opted in as boards; the hooks act only on conversations filed in one.
CREATE TABLE "kanban_boards" (
  -- A conversation folder's id (agent_host.conversation_folders.id, another database).
  "folder_id"  character varying NOT NULL,
  "owner"      character varying NOT NULL,
  "created_at" character varying NOT NULL,
  PRIMARY KEY ("folder_id")
);
CREATE INDEX "ix_kanban_boards_owner" ON "kanban_boards" ("owner");
