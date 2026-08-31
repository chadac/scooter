-- scheduler database — declarative end-state schema (SOURCE OF TRUTH).
--
-- Atlas owns this file; `atlas migrate diff` writes migrations/ from it and the
-- ORM bindings are GENERATED from it via `just db-generate`. Edit tables HERE,
-- never in the service's inline DDL. Consumer: scheduler. Types mirror production
-- (SQLAlchemy `String` -> `character varying`).
-- See todo/draft/DECLARATIVE_SCHEMA_ATLAS.md.

CREATE TABLE "scheduled_tasks" (
  "id"          character varying NOT NULL,
  "title"       text NOT NULL,
  "prompt"      text NOT NULL,
  "cron"        character varying NOT NULL,
  "timezone"    character varying NOT NULL,
  "owner"       character varying NOT NULL,
  "enabled"     boolean NOT NULL,
  "next_run_at" timestamptz NULL,
  "last_run_at" timestamptz NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE "task_runs" (
  "id"              character varying NOT NULL,
  "task_id"         character varying NOT NULL,
  "conversation_id" character varying NULL,
  "status"          character varying NOT NULL,
  "error"           text NULL,
  "fired_at"        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "task_runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "scheduled_tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
