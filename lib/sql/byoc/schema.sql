-- byoc database — declarative end-state schema (SOURCE OF TRUTH).
--
-- Atlas owns this file; `atlas migrate diff` writes migrations/ from it and the
-- ORM bindings are GENERATED from it via `just db-generate`. Edit tables HERE,
-- never in the service's inline DDL. Consumer: byoc-controller.
--
-- This is a SECOND physical `remote_agents` table, distinct from the webhooks-db
-- copy the agent-host writes: this one carries session_id (the durable owner->
-- session mapping the byoc controller persists). All-`text` (raw DDL), matching
-- byoc-controller/sessionStore.ts. See todo/draft/DECLARATIVE_SCHEMA_ATLAS.md.

CREATE TABLE "remote_agents" (
  "owner"      text NOT NULL,
  "status"     text NOT NULL DEFAULT 'offline',
  "last_seen"  timestamptz NOT NULL DEFAULT now(),
  "session_id" text NULL,
  PRIMARY KEY ("owner")
);
