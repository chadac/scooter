-- Modify "conversations" table
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_origin_check" CHECK (origin ~ '^[a-z][a-z0-9_-]{0,31}$'::text), ADD COLUMN "origin" text NULL;
-- Every session so far was started from VS Code.
UPDATE "conversations" SET "origin" = 'vscode' WHERE "kind" = 'session';
