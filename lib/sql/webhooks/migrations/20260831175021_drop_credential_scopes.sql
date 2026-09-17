-- IF EXISTS: same as the remote_agents drop below it — an adopted (`--baseline`)
-- database never ran the baseline, so this table may not exist. This one runs
-- FIRST, so it fails the chain before the other is reached. Why: PR #532.
-- Drop "credential_scopes" table
DROP TABLE IF EXISTS "credential_scopes";
