-- Modify "gitlab_user_tokens" table
ALTER TABLE "gitlab_user_tokens" ADD COLUMN "external_id" character varying NULL;
