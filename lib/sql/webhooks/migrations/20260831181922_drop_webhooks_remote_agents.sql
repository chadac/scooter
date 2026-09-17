-- IF EXISTS: the baseline that creates this table is SKIPPED on a database adopted
-- via `--baseline`, so the table is absent wherever the service never self-created
-- it. Why: PR #532.
-- Drop "remote_agents" table
DROP TABLE IF EXISTS "remote_agents";
