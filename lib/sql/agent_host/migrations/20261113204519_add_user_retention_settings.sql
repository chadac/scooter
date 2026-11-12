-- Create "user_retention_settings" table
CREATE TABLE "user_retention_settings" (
  "owner" text NOT NULL,
  "default_lifetime_hours" integer NOT NULL,
  "updated_at" bigint NOT NULL,
  PRIMARY KEY ("owner"),
  CONSTRAINT "user_retention_settings_default_lifetime_hours_check" CHECK ((default_lifetime_hours >= 0) AND (default_lifetime_hours <= 87600))
);
