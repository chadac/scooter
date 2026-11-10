-- Create "user_ui_settings" table
CREATE TABLE "user_ui_settings" (
  "owner" text NOT NULL,
  "theme_id" text NOT NULL,
  "theme_mode" text NOT NULL,
  "updated_at" bigint NOT NULL,
  PRIMARY KEY ("owner"),
  CONSTRAINT "user_ui_settings_theme_mode_check" CHECK (theme_mode = ANY (ARRAY['light'::text, 'dark'::text, 'system'::text]))
);
