-- Modify "conversation_folders" table
ALTER TABLE "conversation_folders" ADD CONSTRAINT "conversation_folders_icon_check" CHECK (icon ~ '^[a-z0-9-]{1,40}$'::text), ADD COLUMN "icon" text NULL;
