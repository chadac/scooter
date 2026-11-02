-- Create "outsider_replies" table
CREATE TABLE "outsider_replies" (
  "source" character varying NOT NULL,
  "resource_type" character varying NOT NULL,
  "resource_id" character varying NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("source", "resource_type", "resource_id")
);
