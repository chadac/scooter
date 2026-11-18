-- contrib_k8s database — declarative end-state schema (SOURCE OF TRUTH).
--
-- This contrib's OWN database (`contribs.k8s.db`), owned by the broker's role
-- because the store runs inside the broker. Atlas writes ./migrations from this file
-- (`just db-migrate k8s`). The row models in scooter_contrib_k8s/store.py
-- mirror it, and tests/test_db.py holds them together.

-- A grant: while unexpired and unrevoked, the conversation's writes (kind 'write') in
-- this cluster and namespace run without a card, or (kind 'secret') it may read the
-- Secrets in `names`, comma-separated. A NULL `expires_at` lasts until revoked;
-- `parent_id` is the grant a revive renewed.
CREATE TABLE "k8s_grants" (
  "id"              character varying NOT NULL,
  "conversation_id" character varying NOT NULL,
  "cluster"         character varying NOT NULL,
  "namespace"       character varying NOT NULL,
  "kind"            character varying NOT NULL DEFAULT 'write',
  "names"           character varying NOT NULL DEFAULT '',
  "approved_by"     character varying NOT NULL,
  "request_id"      character varying NOT NULL,
  "created_at"      bigint NOT NULL,
  "expires_at"      bigint NULL,
  "revoked_at"      bigint NULL,
  "revoked_by"      character varying NULL,
  "parent_id"       character varying NULL,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_k8s_grants_conversation_id" ON "k8s_grants" ("conversation_id");
