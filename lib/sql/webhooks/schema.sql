-- webhooks database — declarative end-state schema (SOURCE OF TRUTH).
--
-- Atlas owns this file; `atlas migrate diff` writes migrations/ from it and the
-- ORM bindings (@scooter/schema, scooter_schema) are GENERATED from it via
-- `just db-generate`. Edit tables HERE, never in a service's inline DDL.
--
-- Consumers: webhooks (writes all tables) and agent-host, which connects to THIS
-- database for identity enrichment (user_identity) and the conversation_map fallback
-- lookup. The remote-agent badge is NOT here — it lives on byoc.remote_agents, which
-- agent-host and byoc-controller both write. Column types mirror production: the
-- SQLAlchemy tables are `character varying`, the agent-host raw-DDL tables `text`.
-- See todo/draft/DECLARATIVE_SCHEMA_ATLAS.md.

-- External resource (issue/MR/ticket/thread) -> conversation mapping.
CREATE TABLE "conversation_map" (
  "id"              serial NOT NULL,
  "source"          character varying NOT NULL,
  "resource_type"   character varying NOT NULL,
  "resource_id"     character varying NOT NULL,
  "conversation_id" character varying NOT NULL,
  "project_id"      integer NULL,
  "noteable_type"   character varying NULL,
  "noteable_iid"    integer NULL,
  "note_id"         integer NULL,
  "last_status"     character varying NULL,
  "slack_channel"   character varying NULL,
  "slack_ts"        character varying NULL,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "conversation_map_source_resource_type_resource_id_key" UNIQUE ("source", "resource_type", "resource_id")
);

-- Jira ticket -> conversation (many-to-one).
CREATE TABLE "jira_tickets" (
  "id"              serial NOT NULL,
  "conversation_id" character varying NOT NULL,
  "issue_key"       character varying NOT NULL,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "jira_tickets_issue_key_key" UNIQUE ("issue_key")
);

-- Generic cross-platform resource linking. The UNIQUE below is GLOBAL (one
-- conversation per (source, resource_type, resource_id)); #381's open question is
-- whether to scope it per-conversation — that decision is made HERE, in one place.
CREATE TABLE "resource_links" (
  "id"              serial NOT NULL,
  "conversation_id" character varying NOT NULL,
  "source"          character varying NOT NULL,
  "resource_type"   character varying NOT NULL,
  "resource_id"     character varying NOT NULL,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "resource_links_source_resource_type_resource_id_key" UNIQUE ("source", "resource_type", "resource_id")
);

-- Buffered messages for conversations still being created.
CREATE TABLE "pending_messages" (
  "id"            serial NOT NULL,
  "source"        character varying NOT NULL,
  "resource_type" character varying NOT NULL,
  "resource_id"   character varying NOT NULL,
  "message"       text NOT NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);

-- Learned sub->email identity enrichment (agent-host auth/identityStore.ts).
CREATE TABLE "user_identity" (
  "id"         text NOT NULL,
  "email"      text NULL,
  "name"       text NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);
CREATE INDEX "user_identity_email_lower" ON "user_identity" ((lower(email)));
