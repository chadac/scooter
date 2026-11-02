-- Modify "pending_messages" table
ALTER TABLE "pending_messages" ADD COLUMN "sender" jsonb NULL;
