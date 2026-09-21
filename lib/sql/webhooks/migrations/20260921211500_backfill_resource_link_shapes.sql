-- Backfill resource_links into ONE shape. DATA ONLY — no DDL, so `migrate diff`
-- still reports schema.sql fully expressed. Hand-authored (Atlas diffs schema, not
-- data) and hashed with `atlas migrate hash`. Why: PR #571 / issue #563.
--
-- Rows were written in two shapes by two writers: ("pull_request", "o/r#7") by the
-- webhooks handlers, ("pr", "<html_url>") by every link posted through agent-host's
-- /links. Reads now understand both, so this is not what makes the fix work — it is
-- what stops the table carrying two vocabularies forever.
--
-- conversation_map is deliberately NOT touched: its resource_id is matched EXACTLY to
-- route an incoming webhook to its open conversation, so rewriting it would make those
-- events miss and spawn duplicate conversations.
--
-- Every statement is idempotent (re-running changes nothing) and guarded against the
-- UNIQUE (source, resource_type, resource_id): where canonicalising a row would
-- collide with the row it duplicates, the row is left as it is rather than dropped —
-- a stale link in the panel is recoverable, a deleted one is not.

-- 1. resource_id: the short "owner/repo#N" form -> the html_url every other writer uses.
UPDATE "resource_links" AS a
SET "resource_id" = 'https://github.com/'
  || (regexp_match(a."resource_id", '^([^/]+)/([^#]+)#([0-9]+)$'))[1] || '/'
  || (regexp_match(a."resource_id", '^([^/]+)/([^#]+)#([0-9]+)$'))[2]
  || CASE WHEN a."resource_type" IN ('issue', 'issues') THEN '/issues/' ELSE '/pull/' END
  || (regexp_match(a."resource_id", '^([^/]+)/([^#]+)#([0-9]+)$'))[3]
WHERE a."source" = 'github'
  AND a."resource_id" ~ '^[^/]+/[^#]+#[0-9]+$'
  AND NOT EXISTS (
    SELECT 1 FROM "resource_links" b
    WHERE b."source" = a."source"
      AND b."resource_type" = a."resource_type"
      AND b."resource_id" = 'https://github.com/'
        || (regexp_match(a."resource_id", '^([^/]+)/([^#]+)#([0-9]+)$'))[1] || '/'
        || (regexp_match(a."resource_id", '^([^/]+)/([^#]+)#([0-9]+)$'))[2]
        || CASE WHEN a."resource_type" IN ('issue', 'issues') THEN '/issues/' ELSE '/pull/' END
        || (regexp_match(a."resource_id", '^([^/]+)/([^#]+)#([0-9]+)$'))[3]
  );

-- 2. resource_type: the short spellings -> the long form both writers now emit.
UPDATE "resource_links" AS a
SET "resource_type" = 'pull_request'
WHERE a."source" = 'github' AND a."resource_type" = 'pr'
  AND NOT EXISTS (
    SELECT 1 FROM "resource_links" b
    WHERE b."source" = a."source" AND b."resource_type" = 'pull_request'
      AND b."resource_id" = a."resource_id"
  );

UPDATE "resource_links" AS a
SET "resource_type" = 'merge_request'
WHERE a."source" = 'gitlab' AND a."resource_type" = 'mr'
  AND NOT EXISTS (
    SELECT 1 FROM "resource_links" b
    WHERE b."source" = a."source" AND b."resource_type" = 'merge_request'
      AND b."resource_id" = a."resource_id"
  );

UPDATE "resource_links" AS a
SET "resource_type" = 'issue'
WHERE a."source" = 'jira' AND a."resource_type" = 'ticket'
  AND NOT EXISTS (
    SELECT 1 FROM "resource_links" b
    WHERE b."source" = a."source" AND b."resource_type" = 'issue'
      AND b."resource_id" = a."resource_id"
  );

-- 3. ref: the structured target for rows that never carried one (the broker's auto-link
-- injector posts url + title only). Derived from the url, or from resource_id — which
-- IS the url for a row webhooks wrote, since that writer leaves the url column null.
-- agent-host derives this on read too, so the fix does not depend on the backfill; but
-- a reader that does not (the UI, webhooks, anything next) should see what the tools see.
-- A GitLab ISSUE's number goes in `iid`, never `mrIid`: `mrIid` means "merge request N"
-- to the resolver, which is how an issue link came to target an unrelated MR.
UPDATE "resource_links"
SET "ref" = jsonb_build_object(
  'owner',  (regexp_match(coalesce("url", "resource_id"), '^https?://[^/]+/([^/]+)/([^/]+)/(?:pull|issues)/([0-9]+)'))[1],
  'repo',   (regexp_match(coalesce("url", "resource_id"), '^https?://[^/]+/([^/]+)/([^/]+)/(?:pull|issues)/([0-9]+)'))[2],
  'number', ((regexp_match(coalesce("url", "resource_id"), '^https?://[^/]+/([^/]+)/([^/]+)/(?:pull|issues)/([0-9]+)'))[3])::int
)
WHERE "source" = 'github' AND "ref" IS NULL
  AND coalesce("url", "resource_id") ~ '^https?://[^/]+/[^/]+/[^/]+/(pull|issues)/[0-9]+';

UPDATE "resource_links"
SET "ref" = jsonb_build_object(
  'projectId', (regexp_match(coalesce("url", "resource_id"), '^https?://[^/]+/(.+?)/(?:-/)?(merge_requests|issues)/([0-9]+)'))[1],
  CASE WHEN (regexp_match(coalesce("url", "resource_id"), '^https?://[^/]+/(.+?)/(?:-/)?(merge_requests|issues)/([0-9]+)'))[2] = 'merge_requests'
       THEN 'mrIid' ELSE 'iid' END,
  (regexp_match(coalesce("url", "resource_id"), '^https?://[^/]+/(.+?)/(?:-/)?(merge_requests|issues)/([0-9]+)'))[3]
)
WHERE "source" = 'gitlab' AND "ref" IS NULL
  AND coalesce("url", "resource_id") ~ '^https?://[^/]+/.+?/(-/)?(merge_requests|issues)/[0-9]+';

UPDATE "resource_links"
SET "ref" = jsonb_build_object(
  'issueKey', upper((regexp_match(coalesce("url", "resource_id"), '^https?://[^/]+/browse/([A-Za-z][A-Za-z0-9_]*-[0-9]+)'))[1])
)
WHERE "source" = 'jira' AND "ref" IS NULL
  AND coalesce("url", "resource_id") ~ '^https?://[^/]+/browse/[A-Za-z][A-Za-z0-9_]*-[0-9]+';
