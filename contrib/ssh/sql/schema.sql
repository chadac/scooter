-- contrib_ssh database — declarative end-state schema (SOURCE OF TRUTH).
--
-- This contrib's OWN database (`contribs.ssh.db`), owned by the broker's role
-- because the store runs inside the broker. Atlas writes ./migrations from this
-- file (`just db-migrate ssh`). The row model in scooter_contrib_ssh/store.py
-- mirrors it, and tests/test_db.py holds them together.

-- One SSH key per user; `private_key` is the ed25519 seed, sealed (scooter_broker_lib.user_secrets).
CREATE TABLE "ssh_keys" (
  "user_id"     character varying NOT NULL,
  "public_key"  text NOT NULL,
  "fingerprint" character varying NOT NULL,
  "private_key" text NOT NULL,
  "created_at"  character varying NOT NULL,
  PRIMARY KEY ("user_id")
);
