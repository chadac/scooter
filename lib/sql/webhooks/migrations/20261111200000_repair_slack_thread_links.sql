-- Give every Slack thread link its own resource_id, "<channel>:<threadTs>", the id
-- conversation_map uses. DATA ONLY: no DDL, so `migrate diff` still reports
-- schema.sql fully expressed. Hand-authored and hashed with `atlas migrate hash`.
--
-- A url-less Slack link was keyed by its title, "<channel> thread", which every
-- thread in a channel shares; under the GLOBAL unique only the channel's first
-- thread kept a link. conversation_map is read, never written: it routes Slack events.
-- Both statements are idempotent and never take a row another conversation holds.

-- 1. The rows that claimed a channel-wide id: rename them to their own thread.
UPDATE "resource_links" AS a
SET "resource_id" = (a."ref"->>'channel') || ':' || (a."ref"->>'threadTs')
WHERE a."source" = 'slack' AND a."resource_type" = 'thread'
  AND a."url" IS NULL
  AND a."resource_id" LIKE '% thread'
  AND coalesce(a."ref"->>'channel', '') <> ''
  AND coalesce(a."ref"->>'threadTs', '') <> ''
  AND NOT EXISTS (
    SELECT 1 FROM "resource_links" b
    WHERE b."source" = a."source" AND b."resource_type" = a."resource_type"
      AND b."resource_id" = (a."ref"->>'channel') || ':' || (a."ref"->>'threadTs')
  );

-- 2. The links that were dropped: one per Slack-started conversation that has none.
-- '__pending__' marks a thread whose conversation is still being created.
INSERT INTO "resource_links" ("conversation_id", "source", "resource_type", "resource_id", "title", "ref")
SELECT m."conversation_id", 'slack', 'thread', m."resource_id",
       split_part(m."resource_id", ':', 1) || ' thread',
       jsonb_build_object('channel', split_part(m."resource_id", ':', 1),
                          'threadTs', split_part(m."resource_id", ':', 2))
FROM "conversation_map" m
WHERE m."source" = 'slack' AND m."resource_type" = 'thread'
  AND m."conversation_id" <> '__pending__'
  AND m."resource_id" ~ '^[^:]+:[^:]+$'
ON CONFLICT ("source", "resource_type", "resource_id") DO NOTHING;
