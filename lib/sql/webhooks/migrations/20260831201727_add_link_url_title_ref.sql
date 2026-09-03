-- Modify "resource_links" table
ALTER TABLE "resource_links" ADD COLUMN "url" text NULL, ADD COLUMN "title" text NULL, ADD COLUMN "ref" jsonb NULL;
