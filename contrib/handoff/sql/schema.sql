-- contrib_handoff database — declarative end-state schema (SOURCE OF TRUTH).
--
-- This contrib's OWN database (`contribs.handoff.db`), owned by the broker's role
-- because the store runs inside the broker. Atlas writes ./migrations from this file
-- (`just db-migrate handoff`). The row models in scooter_contrib_handoff/store.py
-- mirror it, and tests/test_db.py holds them together.

-- A shared conversation the search index has folded in.
CREATE TABLE "handoff_conversations" (
  "conversation_id"  character varying NOT NULL,
  "title"            text NOT NULL,
  "owner"            character varying NULL,
  "last_activity_at" bigint NOT NULL,
  PRIMARY KEY ("conversation_id")
);

-- One indexed user or assistant message of a shared conversation.
CREATE TABLE "handoff_messages" (
  "conversation_id" character varying NOT NULL,
  "seq"             integer NOT NULL,
  "role"            character varying NOT NULL,
  "text"            text NOT NULL,
  PRIMARY KEY ("conversation_id", "seq")
);
CREATE INDEX "ix_handoff_messages_fts" ON "handoff_messages" USING gin (to_tsvector('english', "text"));

-- A handoff an agent asked for, waiting on (or answered by) the conversation's owner.
CREATE TABLE "handoff_spawn_requests" (
  "id"              character varying NOT NULL,
  "conversation_id" character varying NOT NULL,
  "owner"           character varying NOT NULL,
  "brief"           text NOT NULL,
  "title"           text NOT NULL,
  "model"           character varying NOT NULL,
  "status"          character varying NOT NULL,
  "spawned_id"      character varying NULL,
  "created_at"      bigint NOT NULL,
  "decided_at"      bigint NULL,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_handoff_spawn_requests_pending" ON "handoff_spawn_requests" ("conversation_id", "status");
