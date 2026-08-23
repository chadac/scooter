# Integrations

## Webhooks

GitHub, GitLab, and Slack events spawn or address conversations: an issue comment or a Slack
mention becomes a prompt, attributed to the mapped Scooter user. Provider routes verify
signatures; the webhook service resolves the external identity to an internal owner.

## Scheduled runs

Cron-style scheduled tasks prompt a conversation on a timer — recurring reports, monitors,
maintenance. Scheduled runs never consume a user's personal bring-your-own subscription; they
run on the platform's floor model.

## The broker

A per-conversation **permissions broker** vends scoped credentials into the sandbox — git
credentials, cloud (AWS) access — with a policy and audit layer between the agent and anything
sensitive. Third-party providers plug in as Python modules behind core-enforced middleware.

## Web services from the sandbox

Long-running services the agent starts in its sandbox (a dev server, a notebook, a terminal)
are proxied out through the platform with per-conversation URLs, and survive suspend/resume:
enabled services restart when the sandbox wakes.
