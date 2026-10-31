-- Create "ssh_keys" table
CREATE TABLE "ssh_keys" (
  "user_id" character varying NOT NULL,
  "public_key" text NOT NULL,
  "fingerprint" character varying NOT NULL,
  "private_key" text NOT NULL,
  "created_at" character varying NOT NULL,
  PRIMARY KEY ("user_id")
);
