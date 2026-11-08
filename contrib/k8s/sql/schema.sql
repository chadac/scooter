-- contrib_k8s database — declarative end-state schema (SOURCE OF TRUTH).
--
-- This contrib's OWN database (`contribs.k8s.db`), owned by the broker's role
-- because the store runs inside the broker. Atlas writes ./migrations from this file
-- (`just db-migrate k8s`). The row models in scooter_contrib_k8s/store.py
-- mirror it, and tests/test_db.py holds them together.

-- A time-limited write grant: while unexpired, the conversation's writes in this
-- cluster and namespace run without a card.
CREATE TABLE "k8s_grants" (
  "id"              character varying NOT NULL,
  "conversation_id" character varying NOT NULL,
  "cluster"         character varying NOT NULL,
  "namespace"       character varying NOT NULL,
  "approved_by"     character varying NOT NULL,
  "request_id"      character varying NOT NULL,
  "created_at"      bigint NOT NULL,
  "expires_at"      bigint NOT NULL,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_k8s_grants_conversation_id" ON "k8s_grants" ("conversation_id");
