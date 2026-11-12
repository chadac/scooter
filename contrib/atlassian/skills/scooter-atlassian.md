---
name: scooter-atlassian
type: knowledge
version: 1.0.0
triggers:
- jira
- confluence
- atlassian
- jql
- cql
- atlassian.net
- wiki page
---

# Jira and Confluence: the Atlassian REST APIs (scooter-atlassian)

`curl` and scripts in this sandbox reach Atlassian Cloud without a credential of
yours. The broker's forge proxy intercepts `api.atlassian.com` (and the site,
`$ATLASSIAN_SITE_URL`) and injects a token for the deployment's Atlassian app.
Send no `Authorization` header; the proxy replaces any you send. There is no
token to look for and no login to run.

What you may do is what the app's scopes allow. A 401 or 403 from Atlassian
means the scope or product isn't granted: tell the user, don't work around it.
A 403 with an `X-Scooter-Policy` header is the deployment's policy refusing the
call; report its message.

## Where am I?

```bash
echo "$ATLASSIAN_PRODUCTS"   # the products the proxy authenticates: jira, confluence
echo "$ATLASSIAN_CLOUD_ID"   # the site's cloud id
echo "$ATLASSIAN_SITE_URL"   # e.g. https://acme.atlassian.net; may be empty
```

A product missing from `$ATLASSIAN_PRODUCTS` gets no token, so its calls come back 401.

## URL shapes

Both forms work and are the same request:

| Product | API root | Site form (needs `$ATLASSIAN_SITE_URL`) |
|---|---|---|
| Jira | `https://api.atlassian.com/ex/jira/$ATLASSIAN_CLOUD_ID/rest/api/3/…` | `$ATLASSIAN_SITE_URL/rest/api/3/…` |
| Confluence | `https://api.atlassian.com/ex/confluence/$ATLASSIAN_CLOUD_ID/wiki/api/v2/…` | `$ATLASSIAN_SITE_URL/wiki/api/v2/…` |

Jira Software (`/rest/agile/1.0`) and Service Management (`/rest/servicedeskapi`)
sit under the Jira root. Other site paths (`/browse/…`, `/secure/…`) are web
pages and get no token.

```bash
JIRA="https://api.atlassian.com/ex/jira/$ATLASSIAN_CLOUD_ID/rest/api/3"
WIKI="https://api.atlassian.com/ex/confluence/$ATLASSIAN_CLOUD_ID/wiki/api/v2"

curl -s "$JIRA/myself"
curl -s "$JIRA/issue/ENG-123?fields=summary,status,assignee"
curl -s -G "$JIRA/search/jql" --data-urlencode 'jql=project = ENG AND status = "In Progress"' \
  --data-urlencode 'fields=summary,status'
curl -s "$JIRA/issue/ENG-123/transitions"
curl -s -X POST "$JIRA/issue/ENG-123/transitions" -H 'Content-Type: application/json' \
  -d '{"transition":{"id":"31"}}'

curl -s "$WIKI/spaces?limit=25"
curl -s "$WIKI/pages/123456?body-format=storage"
curl -s -G "https://api.atlassian.com/ex/confluence/$ATLASSIAN_CLOUD_ID/wiki/rest/api/search" \
  --data-urlencode 'cql=type = page AND text ~ "runbook"'
```

Jira REST v3 takes rich text as ADF (Atlassian Document Format); v2
(`/rest/api/2/…`) still takes plain text, which is simpler for comments and
descriptions.

## Links and tools

- An issue you create (`POST …/rest/api/{2,3}/issue`) is linked to this
  conversation automatically. Pages you create are not.
- To comment on the Jira issue this conversation came from, prefer the
  `jira_comment` tool: it finds the issue for you.
