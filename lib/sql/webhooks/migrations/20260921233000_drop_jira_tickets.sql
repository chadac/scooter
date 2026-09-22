-- Retire jira_tickets: a duplicate of resource_links. Hand-authored because the
-- backfill is DATA (Atlas diffs schema), then hashed with `atlas migrate hash`,
-- the same arrangement as the #563 backfill above. Why: PR #587.
--
-- link_jira_ticket() always dual-wrote: a row into jira_tickets AND a generic row
-- into resource_links. Nothing outside four helpers in the webhooks lib store ever
-- read the jira table -- not the agent-host, not the UI -- and #582 moved those
-- helpers onto the generic one, so this table has no readers left.
--
-- The backfill exists for rows written BEFORE the dual-write, which would otherwise
-- vanish with the table. It is idempotent and guarded against
-- UNIQUE (source, resource_type, resource_id): a key already linked (in any shape)
-- is left alone rather than duplicated.

-- 1. Any jira ticket not already present as a generic resource link.
INSERT INTO "resource_links" ("conversation_id", "source", "resource_type", "resource_id", "created_at")
SELECT j."conversation_id", 'jira', 'issue', j."issue_key", j."created_at"
FROM "jira_tickets" AS j
WHERE NOT EXISTS (
  SELECT 1 FROM "resource_links" AS r
  WHERE r."source" = 'jira'
    -- Both shapes count as already-linked. resource_links holds a bare key when
    -- webhooks wrote it, and a /browse/KEY url when the agent-host did; comparing
    -- only the key would insert a second row for a ticket already linked as a url
    -- -- which is the duplication issue #563 is about.
    AND (
      r."resource_id" = j."issue_key"
      OR upper(r."resource_id") LIKE '%/BROWSE/' || upper(j."issue_key")
    )
)
-- Two jira_tickets rows cannot collide with each other (issue_key is UNIQUE there),
-- but belt-and-braces if this is ever re-run mid-flight.
ON CONFLICT ("source", "resource_type", "resource_id") DO NOTHING;

-- 2. The table itself.
DROP TABLE "jira_tickets";
