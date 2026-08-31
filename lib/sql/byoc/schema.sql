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

-- A registered BYOC device (a laptop running the remote agent). The row IS the
-- credential: public_key authenticates the device, so reads and writes here fail
-- closed rather than degrading. Was self-CREATEd by byoc-controller at boot until
-- it was declared here.
CREATE TABLE "remote_agent_devices" (
  "id"          text NOT NULL,
  "owner"       text NOT NULL,
  "public_key"  text NOT NULL,
  "label"       text NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "last_seen"   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);

-- The hot query is "this owner's devices" (cap enforcement + the settings list).
CREATE INDEX "remote_agent_devices_owner_idx" ON "remote_agent_devices" ("owner");
