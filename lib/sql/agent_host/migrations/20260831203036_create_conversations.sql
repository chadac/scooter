-- Create "conversations" table
CREATE TABLE "conversations" (
  "id" text NOT NULL,
  "thread_id" text NOT NULL,
  "title" text NOT NULL,
  "created_at" bigint NOT NULL,
  "last_activity_at" bigint NOT NULL,
  "model" text NULL,
  "owner" text NULL,
  "parent_id" text NULL,
  "user_titled" boolean NULL,
  "starred" boolean NULL,
  "pending_queue" jsonb NULL,
  PRIMARY KEY ("id")
);
-- Create index "conversations_by_activity" to table: "conversations"
CREATE INDEX "conversations_by_activity" ON "conversations" ("last_activity_at" DESC);
-- Create index "conversations_by_owner" to table: "conversations"
CREATE INDEX "conversations_by_owner" ON "conversations" ("owner");
