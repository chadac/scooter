-- Create "remote_agents" table
CREATE TABLE "remote_agents" (
  "owner" text NOT NULL,
  "status" text NOT NULL DEFAULT 'offline',
  "last_seen" timestamptz NOT NULL DEFAULT now(),
  "session_id" text NULL,
  PRIMARY KEY ("owner")
);
