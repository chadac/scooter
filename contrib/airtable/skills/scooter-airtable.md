---
name: scooter-airtable
type: knowledge
version: 1.0.0
triggers:
- airtable
- base
- airtable base
- table
- record
- records
- filterByFormula
- spreadsheet
- read the sheet
- update the row
- add a row
- crm
- tracker
---

# Querying and updating Airtable (scooter-airtable)

You can read and write Airtable through the credential broker. You do **not**
have the Airtable token and never see it: the broker injects
`Authorization: Bearer <PAT>` on the outbound request and returns Airtable's
normal JSON response.

Use the `agent-broker` CLI, which proxies `/airtable/<path>` to the Airtable API
(`https://api.airtable.com`). It wraps `curl`, but the API **path comes FIRST**
as a positional argument (it is not a `-`-flagged URL); any `curl` args go
**after** it:

```bash
agent-broker "airtable/<api-path>" [curl-args...]
```

If an `airtable/...` call returns 404 at the broker, the provider is not enabled
in this deployment (no token configured) — tell the user rather than retrying.

## Find your way around first: bases, then schema

You usually do NOT know the base id (`app…`), table id (`tbl…`) or field names
up front, and **guessing them wastes calls** — every path is opaque ids. Start at
the top:

```bash
# 1. which bases can this token see?  -> id + name for each
agent-broker "airtable/v0/meta/bases" | jq -r '.bases[] | "\(.id)\t\(.name)"'

# 2. the tables in one base -> table ids, field names, field types, views
agent-broker "airtable/v0/meta/bases/appXXXXXXXXXXXXXX/tables" \
  | jq -r '.tables[] | "\(.id)\t\(.name)\t\(.fields | map(.name) | join(", "))"'
```

Read the schema **before** writing a record: Airtable rejects an unknown field
name, and a `singleSelect` only accepts one of its configured options.

## Reading records

```bash
BASE=appXXXXXXXXXXXXXX; TABLE=Tasks     # table id (tbl…) or its name

# a page of records (default 100; maxRecords/pageSize to bound it)
agent-broker "airtable/v0/$BASE/$TABLE?pageSize=20"

# filter + sort (filterByFormula is an Airtable formula, URL-encoded)
agent-broker "airtable/v0/$BASE/$TABLE?filterByFormula=%7BStatus%7D%3D%22Open%22&sort%5B0%5D%5Bfield%5D=Created"

# one record by id
agent-broker "airtable/v0/$BASE/$TABLE/recXXXXXXXXXXXXXX"
```

Two things that bite:

- **A table NAME with a space must be URL-encoded** (`My%20Tasks`), and a name
  changes when someone renames the table. Prefer the `tbl…` id from the schema
  call — it is stable.
- **Results are paginated.** A response with an `offset` has more rows; pass it
  back as `?offset=<value>` until it is absent. Do not report a count from the
  first page as if it were the total.

## Writing records

Create, update and delete are ordinary REST on the same path. Build the body as
a JSON file so quoting survives:

```bash
cat > /tmp/rec.json <<'JSON'
{"records": [{"fields": {"Name": "Ship the thing", "Status": "Open"}}]}
JSON
agent-broker "airtable/v0/$BASE/$TABLE" \
  -X POST -H 'Content-Type: application/json' -d @/tmp/rec.json
```

```bash
# PATCH updates only the fields you send; PUT clears every field you omit.
cat > /tmp/upd.json <<'JSON'
{"records": [{"id": "recXXXXXXXXXXXXXX", "fields": {"Status": "Done"}}]}
JSON
agent-broker "airtable/v0/$BASE/$TABLE" \
  -X PATCH -H 'Content-Type: application/json' -d @/tmp/upd.json

# delete
agent-broker "airtable/v0/$BASE/$TABLE?records%5B%5D=recXXXXXXXXXXXXXX" -X DELETE
```

- **`PATCH`, not `PUT`, to change one field.** `PUT` is a full replace: every
  field you leave out is wiped. This destroys data silently — the call returns
  200 either way.
- Up to **10 records per create/update call**; batch larger jobs.
- A write is **not undoable** through the API. Before a bulk update or any
  delete, say what you are about to change and get the user's go-ahead.

## Rate limits

Airtable allows **5 requests per second per base**. Exceed it and you get a
**429**, after which that base rejects you for ~30 seconds. So do not fan out
parallel calls against one base — run them in sequence, and sleep briefly
between pages of a large scan.

## What you cannot do

- The broker forwards whatever the **token** is allowed to do. A read-only PAT
  makes writes 403 — that is the deployment's choice, not a bug to work around.
- A **401/403** from Airtable is the token's scope; a **404 at the broker** means
  the provider is not configured here. They are different problems — read the
  status before concluding which.
