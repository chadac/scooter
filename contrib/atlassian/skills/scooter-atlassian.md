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
yours. The broker's forge proxy intercepts `api.atlassian.com` and injects a token for the deployment's Atlassian app.
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
```

A product missing from `$ATLASSIAN_PRODUCTS` gets no token, so its calls come back 401.

## URL shapes

Use the `api.atlassian.com` form. The site's own API URLs
(`https://acme.atlassian.net/rest/…`) are not intercepted and get no token.

| Product | API root |
|---|---|
| Jira | `https://api.atlassian.com/ex/jira/$ATLASSIAN_CLOUD_ID/rest/api/3/…` |
| Confluence | `https://api.atlassian.com/ex/confluence/$ATLASSIAN_CLOUD_ID/wiki/api/v2/…` |

Jira Software (`/rest/agile/1.0`) and Service Management (`/rest/servicedeskapi`)
sit under the Jira root.

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

## Confluence tools

With Confluence on, prefer these tools over `curl` for pages. They convert
Markdown to Confluence's storage XHTML and back, handle page versions, and
return Confluence's real error.

| Tool | Does |
|---|---|
| `confluence_search(cql, limit=25)` | CQL search: one line per hit with id, title, space and URL |
| `confluence_get_page(page, format="markdown")` | Read a page by id or URL |
| `confluence_create_page(space, title, body, parent=None)` | Create a page in a space (by key); it is linked to this conversation |
| `confluence_update_page(page, edits=[{old, new}] or body=…, title=None, message=None)` | Change a page |
| `confluence_comment(body, page=None)` | Footer comment; without `page`, on the page linked to this conversation |

- **Bodies are Markdown** unless you pass `format="storage"` for raw XHTML. Fenced
  code becomes Confluence's code macro.
- **Edit, don't rewrite.** `edits` is a list of `{old, new}`, like the edit tool:
  each `old` must match exactly once in the current page or nothing is written.
  Copy `old` from a fresh `confluence_get_page` in the same `format`.
- **Macros and layouts don't survive Markdown.** `confluence_get_page` lists any
  the page has. Markdown edits refuse such a page; read and edit it with
  `format="storage"` instead, which leaves the rest byte for byte.
- **A 409 on update** means someone saved first: re-read and redo the edit.
- `page` takes a numeric id or a URL with `/pages/<id>/` or `?pageId=`. Tiny
  `/x/…` links don't carry an id: search for the page instead.

## Links and tools

- An issue you create (`POST …/rest/api/{2,3}/issue`) or a page you create
  (`POST …/wiki/api/v2/pages`, or v1 `…/wiki/rest/api/content` with
  `"type":"page"`) is linked to this conversation automatically.
- To comment on the Jira issue this conversation came from, prefer the
  `jira_comment` tool: it finds the issue for you.
