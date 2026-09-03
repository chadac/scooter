-- IF NOT EXISTS: byoc-controller self-CREATEd this table at boot, so production
-- already has it. Atlas only skips the BASELINE migration, not this one.
-- Create "remote_agent_devices" table
CREATE TABLE IF NOT EXISTS "remote_agent_devices" (
  "id" text NOT NULL,
  "owner" text NOT NULL,
  "public_key" text NOT NULL,
  "label" text NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);
-- Create index "remote_agent_devices_owner_idx" to table: "remote_agent_devices"
CREATE INDEX IF NOT EXISTS "remote_agent_devices_owner_idx" ON "remote_agent_devices" ("owner");
