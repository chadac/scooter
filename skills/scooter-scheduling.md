---
name: scooter-scheduling
type: knowledge
version: 1.0.0
triggers:
- schedule a task
- scheduled task
- recurring
- every day
- every morning
- every weekday
- run this daily
- run this weekly
- cron
- remind me to
- check in periodically
- do this on a schedule
- automate this
- run automatically
- list my scheduled tasks
- cancel a scheduled task
---

# Scheduling recurring work (scheduled tasks)

You can **schedule yourself to run again later, on a repeating cron schedule.**
Each time a scheduled task fires, Scooter spawns a **fresh conversation** with the
task's `prompt` as the user message and runs it start-to-finish. Use this whenever
the user wants something done *repeatedly* or *later* without them asking each time:
"every weekday at 9am, check the CI dashboard and post a summary to Slack", "every
Monday, open a PR bumping dependencies", "at the end of each day, write a standup
note".

These are **MCP tools** — prefer them over trying to hand-roll cron in the sandbox
(a `crontab` in the pod dies on suspend; scheduled tasks are durable and run on the
platform). Match the tool to your live tool list by purpose:

- **Create a scheduled task** — give it a short `title`, the `prompt` to run each
  time, and a `cron` schedule (+ optional `timezone`). It's owned by you.
- **List scheduled tasks** / **Search scheduled tasks** — see what you already have
  (search matches the title or prompt).
- **View a scheduled task** — one task in detail, including its recent run history.
- **Edit a scheduled task** — change the title, prompt, cron, timezone, or turn it
  on/off (`enabled`). Prefer disabling over deleting when the user just wants a pause.
- **Delete a scheduled task** — permanent; only when the user clearly wants it gone.

## The cron field

`cron` is a standard **5-field** expression: `minute hour day-of-month month
day-of-week`. Examples:

| Schedule | cron |
|----------|------|
| 9:00 every weekday | `0 9 * * 1-5` |
| Every day at 07:30 | `30 7 * * *` |
| Every Monday at 08:00 | `0 8 * * 1` |
| Top of every hour | `0 * * * *` |
| 1st of the month, 06:00 | `0 6 1 * *` |

`timezone` is an IANA name (default **UTC**) — e.g. `America/New_York`. If the user
says "9am" they almost always mean *their* timezone; ask or pass the one you know
rather than silently scheduling in UTC.

## Writing the prompt

Each run is a **brand-new conversation** with no memory of this one — the `prompt`
is all the future run gets. So write it to be **self-contained**: state the goal,
where to look, and what to do with the result (e.g. which Slack thread / PR to post
to). Don't write "do that thing we discussed"; spell it out.

Good: *"Check the failing tests on the `main` branch of acme/api (via the broker
GitHub proxy). If any are failing, post a short summary to Slack channel C0123."*

## Good practice

- **Confirm before creating.** Read the schedule back to the user ("I'll run this
  every weekday at 9am America/New_York — ok?") before creating it, especially for
  anything that posts externally.
- **One task per intent.** If the user changes the timing, *edit* the existing task
  rather than creating a second one — then list to confirm there's no duplicate.
- **Clean up.** Offer to delete or disable a task once its purpose is done.

If you don't see scheduling tools in your tool list, this deployment has no
scheduler — say so rather than faking a cron in the sandbox.
