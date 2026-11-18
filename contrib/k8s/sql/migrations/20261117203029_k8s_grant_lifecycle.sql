-- Modify "k8s_grants" table
ALTER TABLE "k8s_grants" ALTER COLUMN "expires_at" DROP NOT NULL, ADD COLUMN "revoked_at" bigint NULL, ADD COLUMN "revoked_by" character varying NULL, ADD COLUMN "parent_id" character varying NULL;
