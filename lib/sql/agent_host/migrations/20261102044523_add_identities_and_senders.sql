-- Create "identities" table
CREATE TABLE "identities" (
  "id" text NOT NULL,
  "provider" text NOT NULL,
  "external_id" text NOT NULL,
  "handle" text NOT NULL,
  "display_name" text NULL,
  "scooter_user" text NULL,
  "updated_at" bigint NOT NULL,
  PRIMARY KEY ("id")
);
-- Create index "identities_by_scooter_user" to table: "identities"
CREATE INDEX "identities_by_scooter_user" ON "identities" ("scooter_user");
-- Create index "identities_provider_external_id" to table: "identities"
CREATE UNIQUE INDEX "identities_provider_external_id" ON "identities" ("provider", "external_id");
