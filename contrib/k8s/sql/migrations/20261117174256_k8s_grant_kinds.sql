-- Modify "k8s_grants" table
ALTER TABLE "k8s_grants" ADD COLUMN "kind" character varying NOT NULL DEFAULT 'write', ADD COLUMN "names" character varying NOT NULL DEFAULT '';
