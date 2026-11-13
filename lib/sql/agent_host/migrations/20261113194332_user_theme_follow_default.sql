-- Modify "user_ui_settings" table
ALTER TABLE "user_ui_settings" ALTER COLUMN "theme_id" DROP NOT NULL;
-- Auto-saved rows: follow the deployment default instead.
UPDATE "user_ui_settings" SET "theme_id" = NULL WHERE "theme_id" = 'scooter' AND "theme_mode" = 'system';
