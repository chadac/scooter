---
name: scooter-aws
type: knowledge
version: 1.0.0
triggers:
- aws access
- aws permission
- aws credentials
- scooter-aws
- request aws
- iam role
- assume role
- s3 access
- need aws
- approve access
---

# Requesting AWS access (scooter-aws)

You don't have standing AWS credentials. When a task needs AWS, you **request
scoped, time-limited access** and a human **approves it in this very
conversation**. The broker then vends short-lived STS credentials into your
`~/.aws/config` (a profile per account), and `aws --profile <account> …` works.

## First: discover which accounts exist

Don't guess an account alias — **list them** to find the right one for the task:

```bash
scooter-aws accounts
```

This prints each available account with its `description` (what it's for),
`account_id`, what policies are allowed, and `auto_approve_read_only` (whether a
read-only request there is granted with no human). Read the descriptions, pick
the account that matches the task, and use its alias as `--profile` below. Prefer
an `auto_approve_read_only` account for read-only work — it's instant.

## How to request

`--policy` takes a **file path** (or `-` for stdin), and the account is
`--profile`:

```bash
cat > /tmp/pol.json <<'JSON'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
 "Action":["s3:GetObject","s3:ListBucket"],"Resource":"*"}]}
JSON
scooter-aws request \
  --profile <account-alias> \
  --policy /tmp/pol.json \
  --justification "read the deploy bucket to diagnose the failing job"
```

Request the **least privilege** that does the job — narrow actions + resources.
A tightly-scoped request is more likely to be auto-approved or quickly approved.
(`--managed <arn>` requests an allowlisted managed policy instead of/along with
an inline one.)

## What happens — and WHERE approval shows up

The approval appears as an **interrupt in THIS conversation** — the same
conversation you're talking in right now. A human opens the conversation, sees
your request (account, the actions, your justification), and clicks Approve or
Deny. So:

- **Tell the requester where to go.** Your conversation has a shareable URL in
  the `CONVERSATION_URL` environment variable. Share it via the channel you're
  talking on (`slack_respond` / `github_comment` / etc.):
  > "I need AWS access to continue — please approve here: $CONVERSATION_URL"
  Read it with `echo "$CONVERSATION_URL"`. (If it's empty, just say approval is
  pending "in this conversation" and describe what you asked for.)
- **Read-only requests may be auto-approved.** If the account is configured for
  it, a purely read-only policy (all `Get*`/`List*`/`Describe*` actions, no
  managed-policy ARNs) is granted immediately with no human — you'll get creds
  right away. Anything with a write action always needs a human.
- Once approved, use it: `aws --profile <account-alias> s3 ls …`. Credentials
  are short-lived; if they expire mid-task, request again.

## Don't

- Don't retry a denied request in a loop — if denied, explain what you needed and
  ask the human what scope they'd accept.
- Don't ask for `*`/`service:*` when you only need to read — over-broad requests
  won't auto-approve and slow you down.
