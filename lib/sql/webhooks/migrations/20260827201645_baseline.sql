-- Create "conversation_map" table
CREATE TABLE "conversation_map" (
  "id" serial NOT NULL,
  "source" character varying NOT NULL,
  "resource_type" character varying NOT NULL,
  "resource_id" character varying NOT NULL,
  "conversation_id" character varying NOT NULL,
  "project_id" integer NULL,
  "noteable_type" character varying NULL,
  "noteable_iid" integer NULL,
  "note_id" integer NULL,
  "last_status" character varying NULL,
  "slack_channel" character varying NULL,
  "slack_ts" character varying NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "conversation_map_source_resource_type_resource_id_key" UNIQUE ("source", "resource_type", "resource_id")
);
-- Create "credential_scopes" table
CREATE TABLE "credential_scopes" (
  "id" serial NOT NULL,
  "conversation_id" character varying NOT NULL,
  "provider" character varying NOT NULL,
  "scope" character varying NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "credential_scopes_conversation_id_provider_scope_key" UNIQUE ("conversation_id", "provider", "scope")
);
-- Create "jira_tickets" table
CREATE TABLE "jira_tickets" (
  "id" serial NOT NULL,
  "conversation_id" character varying NOT NULL,
  "issue_key" character varying NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "jira_tickets_issue_key_key" UNIQUE ("issue_key")
);
-- Create "pending_messages" table
CREATE TABLE "pending_messages" (
  "id" serial NOT NULL,
  "source" character varying NOT NULL,
  "resource_type" character varying NOT NULL,
  "resource_id" character varying NOT NULL,
  "message" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);
-- Create "remote_agents" table
CREATE TABLE "remote_agents" (
  "owner" text NOT NULL,
  "status" text NOT NULL DEFAULT 'offline',
  "last_seen" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("owner")
);
-- Create "resource_links" table
CREATE TABLE "resource_links" (
  "id" serial NOT NULL,
  "conversation_id" character varying NOT NULL,
  "source" character varying NOT NULL,
  "resource_type" character varying NOT NULL,
  "resource_id" character varying NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "resource_links_source_resource_type_resource_id_key" UNIQUE ("source", "resource_type", "resource_id")
);
-- Create "user_identity" table
CREATE TABLE "user_identity" (
  "id" text NOT NULL,
  "email" text NULL,
  "name" text NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);
-- Create index "user_identity_email_lower" to table: "user_identity"
CREATE INDEX "user_identity_email_lower" ON "user_identity" ((lower(email)));
