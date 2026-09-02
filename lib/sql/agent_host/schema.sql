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

-- Conversation METADATA — the sidebar list and everything the host needs to rehydrate a
-- conversation without opening its event log: title, model, owner, star, parent.
--
-- Why it is not a file: meta.json lived in LOCAL_STATE_PATH, an emptyDir wiped on every
-- rollout, so a redeploy emptied the conversation list until a mirror hydrate refilled it.
--
-- bigint epoch-ms timestamps, matching ConversationMeta in TypeScript. pending_queue is
-- jsonb: the queued-message list is read and written whole, never queried into.
CREATE TABLE "conversations" (
  "id"               text NOT NULL,
  "thread_id"        text NOT NULL,
  -- No DEFAULT: the store always supplies a title (`meta.title ?? ""`), so a database
  -- default would be dead weight. It also trips a drizzle-kit introspection bug that
  -- emits `text().default(')` for an empty-string default, which does not compile.
  "title"            text NOT NULL,
  "created_at"       bigint NOT NULL,
  "last_activity_at" bigint NOT NULL,
  "model"            text NULL,
  "owner"            text NULL,
  "parent_id"        text NULL,
  "user_titled"      boolean NULL,
  "starred"          boolean NULL,
  "pending_queue"    jsonb NULL,
  PRIMARY KEY ("id")
);

-- The sidebar lists newest-active first.
CREATE INDEX "conversations_by_activity" ON "conversations" ("last_activity_at" DESC);

-- Per-owner filtering for the conversation list.
CREATE INDEX "conversations_by_owner" ON "conversations" ("owner");

-- The conversation EVENT LOG — the durable replacement for events.jsonl on the
-- wiped emptyDir, and for the NFS mirror that existed only to survive that.
-- There is no second copy, so there is no divergence to reconcile.
--
-- `seq` is per-conversation and assigned by the writing pod (one pod owns a
-- conversation at a time). The PK is the backstop, NOT just an index: if that
-- assumption is ever violated the second writer gets a unique violation instead
-- of silently interleaving. Inserts here must never ON CONFLICT DO NOTHING.
--
-- The PK also serves both reads: `WHERE conversation_id = $1 ORDER BY seq` is a
-- range scan over adjacent rows, and the tail walks the same index.
--
-- checksum/prev_checksum are STORED, never recomputed from `event`: jsonb does
-- not preserve key order and canonicalize() sorts only top-level keys, so a
-- chain re-derived from the column could never match the writer's. These two
-- columns are the only copy of that truth.
CREATE TABLE "conversation_events" (
  "conversation_id" text   NOT NULL,
  "seq"             bigint NOT NULL,
  "event"           jsonb  NOT NULL,
  "checksum"        text   NOT NULL,
  "prev_checksum"   text   NOT NULL,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("conversation_id", "seq")
);

-- Conversation ASSETS (images, future: other media) — metadata only.
-- The asset BYTES live on the dedicated assets PVC (/var/lib/agent-assets),
-- keyed by asset_id. This table holds the metadata: what exists, for which
-- conversation, when, how big, what type. Clean separation: queryable metadata
-- in Postgres, efficient blob storage on disk.
--
-- asset_id is content-addressed (SHA-256 prefix + extension), so identical
-- uploads dedupe automatically. The bytes are written once per unique content;
-- metadata rows can reference the same asset_id (different conversations
-- pasting the same image).
--
-- Lifecycle: assets are conversation-scoped. When a conversation is deleted,
-- its asset metadata rows are removed. A separate GC job (future) removes
-- orphaned bytes (asset_id on disk with no referencing metadata row).
CREATE TABLE "conversation_assets" (
  "conversation_id" text   NOT NULL,
  "asset_id"        text   NOT NULL,
  "mime_type"       text   NOT NULL,
  "size_bytes"      bigint NOT NULL,
  "sha256_hash"     text   NOT NULL,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("conversation_id", "asset_id")
);

-- Find all assets for a conversation (for clear/replay).
CREATE INDEX "conversation_assets_by_conv" ON "conversation_assets" ("conversation_id");

-- Find orphaned asset_ids (bytes on disk with no metadata row) for GC.
CREATE INDEX "conversation_assets_by_id" ON "conversation_assets" ("asset_id");
