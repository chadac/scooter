-- Create "github_user_tokens" table
CREATE TABLE "github_user_tokens" (
  "user_id" character varying NOT NULL,
  "kind" character varying NOT NULL,
  "login" character varying NOT NULL,
  "name" character varying NOT NULL,
  "email" character varying NOT NULL,
  "access_token" text NOT NULL,
  "access_expires_at" bigint NULL,
  "refresh_token" text NULL,
  "refresh_expires_at" bigint NULL,
  "broken" boolean NOT NULL,
  "updated_at" bigint NOT NULL,
  PRIMARY KEY ("user_id")
);
