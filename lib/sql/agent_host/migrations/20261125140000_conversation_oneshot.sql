-- Modify "conversations" table
ALTER TABLE "conversations" ADD COLUMN "oneshot" boolean NOT NULL DEFAULT false;
