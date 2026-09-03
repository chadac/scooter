-- Create "conversation_jobs" table
CREATE TABLE "conversation_jobs" (
  "conversation_id" text NOT NULL,
  "job_id" text NOT NULL,
  "command" text NOT NULL,
  "started_at" bigint NOT NULL,
  "notified_at" bigint NULL,
  PRIMARY KEY ("conversation_id", "job_id")
);
-- Create index "conversation_jobs_by_conv" to table: "conversation_jobs"
CREATE INDEX "conversation_jobs_by_conv" ON "conversation_jobs" ("conversation_id", "started_at" DESC);
