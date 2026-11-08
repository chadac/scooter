-- broker database — declarative end-state schema (SOURCE OF TRUTH).
--
-- Atlas owns this file; `atlas migrate diff` writes migrations/ from it and the
-- ORM bindings are GENERATED from it via `just db-generate`. Edit tables HERE,
-- never in the service's inline DDL. Consumer: broker. Types mirror production
-- (SQLAlchemy `String` -> `character varying`, `Text` -> `text`).
--
-- NOTE: the optional OpenFGA store uses its OWN database (`openfga`) whose schema
-- is owned by the OpenFGA migrator, not Atlas — it is intentionally not modelled
-- here. See todo/draft/DECLARATIVE_SCHEMA_ATLAS.md.
--
-- Two tables here belong to a CONTRIB and are LEGACY: `permission_requests`
-- (contrib/aws) and `annotations` (contrib/files) now live in each contrib's own
-- database (`contribs.<name>.db`, DDL in contrib/<name>/sql). They stay here only
-- as the migrator's one-time copy source (`copyFrom = "broker"`), and the next
-- release drops them, together with their ownership rows and `copyFrom`. Do not
-- change them here; a contrib's schema changes go in its own sql/ (#777).

-- Per-conversation sandbox size spec (sandbox/store.py).
CREATE TABLE "sandbox_size" (
  "conversation_id" character varying NOT NULL,
  "spec_json"       text NOT NULL,
  "updated_at"      character varying NOT NULL,
  PRIMARY KEY ("conversation_id")
);

-- Scoped, time-limited AWS access requests (aws/store.py).
CREATE TABLE "permission_requests" (
  "request_id"            character varying NOT NULL,
  "conversation_id"       character varying NOT NULL,
  "target_account"        character varying NOT NULL,
  "justification"         text NOT NULL,
  "status"                character varying NOT NULL,
  "risk_level"            character varying NOT NULL,
  "policy_document"       text NULL,
  "managed_policy_arns"   text NOT NULL,
  "policy_summary"        text NOT NULL,
  "conversation_url"      text NULL,
  "parent_request_id"     character varying NULL,
  "requested_at"          character varying NOT NULL,
  "approved_at"           character varying NULL,
  "approved_by"           character varying NULL,
  "denied_at"             character varying NULL,
  "denied_by"             character varying NULL,
  "deny_reason"           text NULL,
  "revoked_at"            character varying NULL,
  "iam_role_arn"          character varying NULL,
  "iam_policy_arn"        character varying NULL,
  "role_expires_at"       character varying NULL,
  "credentials_issued_at" character varying NULL,
  "expires_at"            character varying NULL,
  PRIMARY KEY ("request_id")
);
CREATE INDEX "ix_permission_requests_conversation_id" ON "permission_requests" ("conversation_id");
CREATE INDEX "ix_permission_requests_status" ON "permission_requests" ("status");
CREATE INDEX "ix_permission_requests_target_account" ON "permission_requests" ("target_account");

-- Published static shares — metadata head row (shares/store.py).
CREATE TABLE "static_shares" (
  "uuid"            character varying NOT NULL,
  "owner"           character varying NOT NULL,
  "conversation_id" character varying NOT NULL,
  "description"     text NOT NULL,
  "visibility"      character varying NOT NULL,
  "latest_version"  integer NOT NULL,
  "created_at"      character varying NOT NULL,
  "updated_at"      character varying NOT NULL,
  PRIMARY KEY ("uuid")
);
CREATE INDEX "ix_static_shares_owner" ON "static_shares" ("owner");
CREATE INDEX "ix_static_shares_conversation_id" ON "static_shares" ("conversation_id");
CREATE INDEX "ix_static_shares_visibility" ON "static_shares" ("visibility");

-- One immutable snapshot of a share's files per version (shares/store.py).
CREATE TABLE "static_share_versions" (
  "id"          serial NOT NULL,
  "share_uuid"  character varying NOT NULL,
  "version"     integer NOT NULL,
  "entry_point" character varying NOT NULL,
  "files_json"  text NOT NULL,
  "created_at"  character varying NOT NULL,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_static_share_versions_share_uuid" ON "static_share_versions" ("share_uuid");

-- Comments and answers a human anchors to a location in a sandbox file, owned by
-- the files contrib (contrib/files/scooter_contrib_files/store.py). The viewer
-- resolves the anchor against live content and pushes an already-validated record
-- here, so this table is a dumb, correct store.
-- `id` is supplied by the caller, not minted here: the viewer retries a failed push
-- from an outbox, and a broker-minted id would turn every lost ack into a duplicate.
CREATE TABLE "annotations" (
  "id"              character varying NOT NULL,
  "conversation_id" character varying NOT NULL,
  "path"            character varying NOT NULL,
  "anchor_line"     integer NOT NULL,
  "anchor_quote"    text NOT NULL,
  "kind"            character varying NOT NULL,
  "question_id"     character varying NULL,
  "thread"          character varying NOT NULL,
  "author"          character varying NOT NULL,
  "body"            text NOT NULL,
  "resolved"        boolean NOT NULL,
  "created_at"      character varying NOT NULL,
  "updated_at"      character varying NOT NULL,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_annotations_conversation_id" ON "annotations" ("conversation_id");
CREATE INDEX "ix_annotations_thread" ON "annotations" ("thread");
CREATE INDEX "ix_annotations_path" ON "annotations" ("path");

-- A human approval an agent raised through scooter_broker_lib.approvals, waiting on
-- (or answered by) a person. Shared by every approval contrib: `contrib` scopes each
-- row, and `payload` is that contrib's own JSON, opaque here.
CREATE TABLE "approval_requests" (
  "id"              character varying NOT NULL,
  "contrib"         character varying NOT NULL,
  "conversation_id" character varying NOT NULL,
  "owner"           character varying NOT NULL,
  "payload"         text NOT NULL,
  "status"          character varying NOT NULL,
  "decided_by"      character varying NULL,
  "created_at"      bigint NOT NULL,
  "decided_at"      bigint NULL,
  "expires_at"      bigint NULL,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_approval_requests_conversation" ON "approval_requests" ("contrib", "conversation_id", "status");
CREATE INDEX "ix_approval_requests_owner" ON "approval_requests" ("contrib", "owner", "status");
