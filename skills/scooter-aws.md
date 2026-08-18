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

- **Tell the requester where to go — with the REAL link, not the variable name.**
  Your conversation URL is in the `CONVERSATION_URL` env var. You MUST expand it
  to its actual value first — get the value:
  ```bash
  echo "$CONVERSATION_URL"
  # e.g. https://scooter.example.com/?thread=6f1c...
  ```
  then paste **that actual URL** into your message via `slack_respond` /
  `github_comment` / etc. — for example:
  > "I need AWS access to continue — please approve here:
  >  https://scooter.example.com/?thread=6f1c..."
  Do NOT send the literal text `$CONVERSATION_URL` (the requester can't click
  that). If `echo "$CONVERSATION_URL"` prints nothing, omit the link and say the
  approval is pending "in this conversation," describing what you asked for.
- **Read-only requests may be auto-approved.** If the account is configured for
  it, a purely read-only policy (all `Get*`/`List*`/`Describe*` actions, no
  managed-policy ARNs) is granted immediately with no human — you'll get creds
  right away. Anything with a write action always needs a human.
- Once approved, use it: `aws --profile <account-alias> s3 ls …`. Credentials
  are short-lived; the profile refreshes them for you automatically.

## After you request: how to WAIT for approval

Requesting does **not** pause you and you are **not** auto-notified when a human
approves — a write request comes back `pending` and you must **poll** until it's
`active`. Do this:

1. Post the approval link (above) so a human knows to act.
2. Poll the request until it flips to `active`:
   ```bash
   scooter-aws status <request_id>     # -> "status": "pending" | "active" | "denied"
   ```
   Check every ~15–30s. It stays `pending` until a human approves — that can take
   minutes. Keep waiting; don't give up after one check.
3. When it's `active`, the credentials are ready — just run `aws --profile
   <account-alias> …` (the profile pulls them; you don't copy tokens).
4. If it goes `denied`, read the reason, adjust the scope, and ask the human —
   don't silently re-request the same thing.

## Need MORE permissions than you asked for? — `escalate`

If you already have a request (pending OR active) for an account and need ADDITIONAL
scope, **escalate it** — don't fire a second plain `request`:

```bash
scooter-aws escalate <request_id> --profile <account-alias> \
    --policy more.json --justification "also need s3:PutObject to upload the build"
```

`escalate` creates a new request linked to the parent and, **once a human approves it**,
SUPERSEDES the old one — so exactly one grant is live per account (your old, narrower
grant is replaced cleanly, and its IAM role is torn down). Escalation needs approval like
any request. Your existing grant keeps working while the escalation is pending, and if the
escalation is **denied** your original grant is left untouched.

The `--policy` you pass is the FULL policy you now need (state the complete scope, not just
the delta) — the approved grant is exactly that policy.

**Do NOT create a NEW plain `request` while one is still `pending`/`active`** for the same
account — use `escalate` instead. (A second plain request now supersedes the first anyway,
so piling them up only wastes approvals; escalate makes the intent — expanding — explicit.)

If `aws --profile … ` ever fails with an expired/invalid token even though your
request is `active`, force a fresh token instead of re-requesting:
```bash
scooter-aws refresh <request_id>
```

## Don't

- Don't retry a denied request in a loop — if denied, explain what you needed and
  ask the human what scope they'd accept.
- Don't ask for `*`/`service:*` when you only need to read — over-broad requests
  won't auto-approve and slow you down.
