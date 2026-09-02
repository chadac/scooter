-- Create "conversation_assets" table
CREATE TABLE "conversation_assets" (
  "conversation_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "sha256_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("conversation_id", "asset_id")
);
-- Create index "conversation_assets_by_conv" to table: "conversation_assets"
CREATE INDEX "conversation_assets_by_conv" ON "conversation_assets" ("conversation_id");
-- Create index "conversation_assets_by_id" to table: "conversation_assets"
CREATE INDEX "conversation_assets_by_id" ON "conversation_assets" ("asset_id");
