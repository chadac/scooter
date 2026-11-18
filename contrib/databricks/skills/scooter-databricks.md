---
name: scooter-databricks
type: knowledge
version: 1.0.0
triggers:
- databricks
- dbsql
- unity catalog
- databricks sql
- spark job
- cloud.databricks.com
---

# Databricks workspaces (scooter-databricks)

This sandbox reaches the user's Databricks workspaces as the user. The broker's
forge proxy adds a short-lived token for each workspace's `/api/` paths; there
is no token to find, and `DATABRICKS_TOKEN` is a placeholder the proxy replaces.

```bash
echo "$DATABRICKS_WORKSPACES" | jq .     # {"<name>": "https://…", …}
H=$(echo "$DATABRICKS_WORKSPACES" | jq -r .dev)
curl -s "$H/api/2.0/clusters/list" | jq '.clusters[].cluster_name'
curl -s "$H/api/2.0/sql/warehouses" | jq '.warehouses[] | {id, name, state}'
```

The SDK and CLI work with `DATABRICKS_HOST=$H` (the placeholder token is already
set): `DATABRICKS_HOST=$H python -c 'from databricks.sdk import WorkspaceClient; print(WorkspaceClient().current_user.me().user_name)'`.
`agent-broker databricks-<name>/api/2.0/…` works too.

**Pick the workspace deliberately.** Ask which one if the user hasn't said. Never
write to, run jobs in, or change a production workspace without the user saying
so in this conversation. A SQL statement is a POST either way, so treat any
production statement that isn't a plain `SELECT` as a write.

A 401 means that workspace's token is missing or expired: tell the user, don't
retry. A 403 means they lack the permission.
