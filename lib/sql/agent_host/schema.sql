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
  -- Who chose `model`; the agent keeps a user's pick.
  "model_set_by"     text NULL CHECK ("model_set_by" IN ('user', 'agent')),
  "owner"            text NULL,
  "parent_id"        text NULL,
  -- A child's kind; NULL for a top-level conversation.
  "kind"             text NULL CHECK ("kind" IN ('subagent', 'session')),
  "user_titled"      boolean NULL,
  -- Owner's star: agent-host's delete guard, derived by the router.
  "starred"          boolean NULL,
  "pending_queue"    jsonb NULL,
  -- Sidebar turn state: set while a run is in flight, NULL otherwise.
  "run_started_at"   bigint NULL,
  -- When the last run ended; the UI compares it to its last-seen mark for "unread".
  "last_reply_at"    bigint NULL,
  -- shared (anyone signed in) | private (the owner only). A private row always has an owner.
  "visibility"       text NOT NULL DEFAULT 'shared' CHECK ("visibility" IN ('shared', 'private')),
  -- ASSIGNMENT / FENCING. host_*, not owner_*: "owner" above is the end user.
  --
  -- host_pod is a pod NAME, never an IP: a name is stable identity, an IP is a mutable
  -- fact Kubernetes owns and can reassign silently. The router resolves name -> address at
  -- route time. A stale name fails closed; a stale IP succeeds against the wrong pod.
  "host_pod"         text NULL,
  -- Fence epoch, bumped by the assigner on every (re)assignment. NOT NULL DEFAULT 0 is
  -- load-bearing: the claim is `WHERE $gen > host_generation`, and `$gen > NULL` is NULL,
  -- so a nullable column would make every claim fail and nothing could ever be assigned.
  "host_generation"  bigint NOT NULL DEFAULT 0,
  -- Pending | Assigned | Suspended. (The CR also declared Orphaned, never written.)
  "phase"            text NULL,
  "sandbox_ref"      text NULL,
  "creator_pod"      text NULL,
  -- Private for nobody is meaningless: canAccess would let no one in.
  CONSTRAINT "conversations_private_has_owner" CHECK ("visibility" = 'shared' OR "owner" IS NOT NULL),
  PRIMARY KEY ("id")
);

-- The sidebar lists newest-active first.
CREATE INDEX "conversations_by_activity" ON "conversations" ("last_activity_at" DESC);
-- The router resolves a sandbox short-id to its conversation.
CREATE INDEX "conversations_by_sandbox_ref" ON "conversations" ("sandbox_ref");

-- Per-owner filtering for the conversation list.
CREATE INDEX "conversations_by_owner" ON "conversations" ("owner");
-- The author check walks a conversation's subagents.
CREATE INDEX "conversations_by_parent" ON "conversations" ("parent_id");

-- LIVE CONVERSATION-LIST PUSH — a NOTIFY trigger on this table (channel
-- 'conversations_changed') lets the conversation-router serve GET /conversations/events by
-- LISTENing instead of fanning SSE out to every agent-host pod. It is NOT declared here:
-- Atlas Community does not diff FUNCTION/TRIGGER objects (`migrate diff` reports "synced,
-- no changes" for them), so a declaration in this file would silently never reach a
-- migration — and production is built by REPLAYING migrations, not by applying this file.
-- The trigger's source of truth is therefore its migrations:
--   migrations/<ts>_notify_conversation_changes.sql — the triggers (which columns push)
--   migrations/<ts>_notify_conversation_owner.sql   — the payload ({id, op, owner})
-- Keep the two in sync by hand when the notified columns change (that migration and the
-- router's assembleList are the only two places that must agree on which changes push).
-- Assignment changes notify 'conversation_assignment' instead, for the router.

-- Per-user sidebar FOLDERS, nested 3 deep, plus a built-in Starred each.
CREATE TABLE "conversation_folders" (
  "id"         text   NOT NULL,
  -- Ingress identity; empty when the deployment has none.
  "owner"      text   NOT NULL,
  "kind"       text   NOT NULL DEFAULT 'user' CHECK ("kind" IN ('starred', 'user')),
  -- Only a folder service changes it; users just file conversations.
  "locked"     boolean NOT NULL DEFAULT false,
  -- The enclosing user folder; null at the top level.
  "parent_id"  text,
  "name"       text   NOT NULL CHECK (length("name") BETWEEN 1 AND 100),
  -- An optional Lucide icon name shown instead of the folder glyph.
  "icon"       text   CHECK ("icon" ~ '^[a-z0-9-]{1,40}$'),
  -- Idle hours before deletion; 0 is forever, null inherits.
  "conversation_lifetime_hours" integer CHECK ("conversation_lifetime_hours" >= 0),
  -- Fractional, so a reorder rewrites one row; ordered among siblings.
  "position"   double precision NOT NULL,
  "created_at" bigint NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "conversation_folders_parent" FOREIGN KEY ("parent_id") REFERENCES "conversation_folders" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "conversation_folders_name" ON "conversation_folders" ("owner", (COALESCE("parent_id", '')), (lower("name"))) WHERE ("kind" = 'user');
CREATE UNIQUE INDEX "conversation_folders_one_starred" ON "conversation_folders" ("owner") WHERE ("kind" = 'starred');
CREATE INDEX "conversation_folders_by_parent" ON "conversation_folders" ("parent_id");

-- Per-user metadata on a conversation; for now, its folder.
CREATE TABLE "user_conversation_metadata" (
  "owner"           text NOT NULL,
  "conversation_id" text NOT NULL,
  "folder_id"       text NOT NULL,
  PRIMARY KEY ("owner", "conversation_id"),
  CONSTRAINT "user_conversation_metadata_conversation" FOREIGN KEY ("conversation_id") REFERENCES "conversations" ("id") ON DELETE CASCADE,
  CONSTRAINT "user_conversation_metadata_folder" FOREIGN KEY ("folder_id") REFERENCES "conversation_folders" ("id") ON DELETE CASCADE
);
CREATE INDEX "user_conversation_metadata_by_folder" ON "user_conversation_metadata" ("folder_id");

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
-- Run boundaries, so settlement skips message events.
CREATE INDEX "conversation_events_run_markers" ON "conversation_events" ("conversation_id", "seq")
  WHERE ((event ->> 'type'::text) = ANY (ARRAY['RUN_STARTED'::text, 'RUN_FINISHED'::text, 'RUN_ERROR'::text, 'CANCEL_REQUESTED'::text]));

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

-- PERSONALIZED skills: markdown a user writes in the settings page, injected into their
-- own conversations alongside the deployment's ConfigMap skills. The ConfigMap is a
-- deployment-wide, cluster-admin artifact; this table is the per-user half, so a user can
-- teach the agent about their repos and habits without a redeploy.
--
-- `owner` is the ingress identity, or the literal 'anonymous' for a deployment with no
-- identity ingress (one shared bucket, which is the right answer for a single-user box).
-- `name` is the filename the agent sees, so it is unique per owner and constrained to a
-- filesystem-safe charset by the store, never by a CHECK: the validation message has to
-- reach the settings form.
--
-- `description` is its own column rather than parsed out of `body` because the Claude SDK
-- matches on it to decide a skill is relevant, and a skill whose frontmatter fails to
-- parse is silently dropped. Deriving it (skillDescription) is a fallback for the
-- platform's own skills, which predate the field; a skill authored in a form can just ask.
--
-- bigint epoch-ms timestamps, matching the other agent_host tables.
CREATE TABLE "user_skills" (
  "id"          text NOT NULL,
  "owner"       text NOT NULL,
  "name"        text NOT NULL,
  "description" text NOT NULL,
  "body"        text NOT NULL,
  "enabled"     boolean NOT NULL DEFAULT true,
  "created_at"  bigint NOT NULL,
  "updated_at"  bigint NOT NULL,
  PRIMARY KEY ("id")
);

-- The injection path reads one owner's enabled skills at every conversation start, so this
-- index is on the hot path, not just the settings page.
CREATE INDEX "user_skills_by_owner" ON "user_skills" ("owner");

-- A name is the agent-visible filename, so one owner cannot have two.
CREATE UNIQUE INDEX "user_skills_owner_name" ON "user_skills" ("owner", "name");

-- A user's choice for a deployment hook that allows opting out (`userCanDisable`). No row
-- means the hook's default, which is on; the bridge reads one owner's rows per conversation.
CREATE TABLE "user_hook_settings" (
  "owner"      text NOT NULL,
  "hook_id"    text NOT NULL,
  "enabled"    boolean NOT NULL,
  "updated_at" bigint NOT NULL,
  PRIMARY KEY ("owner", "hook_id")
);

-- One account in one system, keyed by that system's stable id so a rename keeps
-- what was granted to it. Created the first time a message names it; `handle`
-- is refreshed from each one. `scooter_user` is set once the account is linked.
CREATE TABLE "identities" (
  "id"           text NOT NULL,
  "provider"     text NOT NULL,
  "external_id"  text NOT NULL,
  "handle"       text NOT NULL,
  "display_name" text NULL,
  "scooter_user" text NULL,
  "updated_at"   bigint NOT NULL,
  PRIMARY KEY ("id")
);

-- An inbound message is looked up by its sender's stable id.
CREATE UNIQUE INDEX "identities_provider_external_id" ON "identities" ("provider", "external_id");

-- The rule finds an owner's own accounts through this.
CREATE INDEX "identities_by_scooter_user" ON "identities" ("scooter_user");

-- Who other than the owner wrote text a conversation's agent acts on, one row per author.
-- kind is identity (an identities.id), user (a users.id) or unknown (author ''): text
-- whose writer can't be named. The broker vends personal credentials only while every
-- author in the conversation's tree is its owner.
CREATE TABLE "conversation_authors" (
  "conversation_id" text   NOT NULL,
  "kind"            text   NOT NULL CHECK ("kind" IN ('identity', 'user', 'unknown')),
  "author"          text   NOT NULL,
  "first_at"        bigint NOT NULL, -- epoch ms this author first wrote here
  PRIMARY KEY ("conversation_id", "kind", "author")
);
