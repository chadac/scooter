-- agent_host database — declarative end-state schema (SOURCE OF TRUTH).
--
-- Atlas owns this file; `atlas migrate diff` writes migrations/ from it and the ORM
-- bindings are GENERATED via `just db-generate`. Edit tables HERE, never in a service's
-- inline DDL. Consumer: agent-host.
--
-- Named for the service that WRITES these tables. agent-host also writes user_identity,
-- which still lives in the webhooks database for historical reasons — moving it is a real
-- migration, not part of this schema. See todo/draft/SHARED_DB_TABLE_OWNERSHIP.md.

-- The background-job REGISTRY: the per-conversation index answering "which jobs does this
-- conversation have?". A job's OUTPUT (log, exit status, pid) is NOT here — it stays in-pod
-- on the workspace PVC, which survives suspend/resume.
--
-- Why it is not a file: jobs.json lived in LOCAL_STATE_PATH, an emptyDir wiped on every
-- rollout, and unlike meta and events hydrateFromMirror never copied it — so
-- list_background silently lost a conversation's jobs whenever its pod moved.
--
-- bigint epoch-ms timestamps, matching what JobRecord carries in TypeScript.
CREATE TABLE "conversation_jobs" (
  "conversation_id" text NOT NULL,
  "job_id"          text NOT NULL,
  "command"         text NOT NULL,
  "started_at"      bigint NOT NULL,
  "notified_at"     bigint NULL,
  PRIMARY KEY ("conversation_id", "job_id")
);

-- list() is always scoped to one conversation and ordered newest-first.
CREATE INDEX "conversation_jobs_by_conv" ON "conversation_jobs" ("conversation_id", "started_at" DESC);
