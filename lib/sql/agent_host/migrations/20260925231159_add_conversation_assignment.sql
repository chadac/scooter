-- Modify "conversations" table
ALTER TABLE "conversations" ADD COLUMN "host_pod" text NULL, ADD COLUMN "host_generation" bigint NOT NULL DEFAULT 0, ADD COLUMN "phase" text NULL, ADD COLUMN "sandbox_ref" text NULL, ADD COLUMN "creator_pod" text NULL;
