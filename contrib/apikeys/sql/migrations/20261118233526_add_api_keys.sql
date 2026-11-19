-- Create "api_keys" table
CREATE TABLE "api_keys" (
  "key_id" character varying NOT NULL,
  "user_id" character varying NOT NULL,
  "name" character varying NOT NULL,
  "secret_digest" character varying NOT NULL,
  "scopes" character varying NOT NULL,
  "created_at" character varying NOT NULL,
  "expires_at" character varying NOT NULL,
  "last_used_at" character varying NULL,
  "last_used_ip" character varying NULL,
  PRIMARY KEY ("key_id")
);
-- Create index "api_keys_user_id_idx" to table: "api_keys"
CREATE INDEX "api_keys_user_id_idx" ON "api_keys" ("user_id");
