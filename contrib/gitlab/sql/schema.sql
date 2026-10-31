-- contrib_gitlab database — declarative end-state schema (SOURCE OF TRUTH).
--
-- This contrib's OWN database (`contribs.gitlab.db`, only with userAuth on), owned
-- by the broker's role because the store runs inside the broker. Atlas writes
-- ./migrations from this file (`just db-migrate <name>`). The row model
-- (scooter_broker_lib.user_auth.user_token_table) mirrors it; tests/test_db.py
-- holds them together.

-- Each user's linked GitLab account; both tokens are sealed (scooter_broker_lib.user_secrets).
CREATE TABLE "gitlab_user_tokens" (
  "user_id"            character varying NOT NULL,
  "kind"               character varying NOT NULL,
  "login"              character varying NOT NULL,
  "name"               character varying NOT NULL,
  "email"              character varying NOT NULL,
  "access_token"       text NOT NULL,
  "access_expires_at"  bigint NULL,
  "refresh_token"      text NULL,
  "refresh_expires_at" bigint NULL,
  "broken"             boolean NOT NULL,
  "updated_at"         bigint NOT NULL,
  PRIMARY KEY ("user_id")
);
