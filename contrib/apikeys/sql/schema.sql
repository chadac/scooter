-- contrib_apikeys database — declarative end-state schema (SOURCE OF TRUTH).
--
-- This contrib's OWN database (`contribs.apikeys.db`), owned by the broker's
-- role because the store runs inside the broker. Atlas writes ./migrations from
-- this file (`just db-migrate apikeys`). The row model in
-- scooter_contrib_apikeys/store.py mirrors it, and tests/test_db.py holds
-- them together.

-- A user's API keys; `secret_digest` is the SHA-256 of the key's secret, never the key.
CREATE TABLE "api_keys" (
  "key_id"        character varying NOT NULL,
  "user_id"       character varying NOT NULL,
  "name"          character varying NOT NULL,
  "secret_digest" character varying NOT NULL,
  "scopes"        character varying NOT NULL,
  "created_at"    character varying NOT NULL,
  "expires_at"    character varying NOT NULL,
  "last_used_at"  character varying NULL,
  "last_used_ip"  character varying NULL,
  PRIMARY KEY ("key_id")
);
CREATE INDEX "api_keys_user_id_idx" ON "api_keys" ("user_id");
