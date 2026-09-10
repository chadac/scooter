# Integrations

## Webhooks

GitHub, GitLab, and Slack events spawn or address conversations: an issue comment or a Slack
mention becomes a prompt, attributed to the mapped Scooter user. Provider routes verify
signatures; the webhook service resolves the external identity to an internal owner.

### Who may trigger a run

A signature proves the *provider* sent the event, not that the person who wrote the comment
has any standing on the repo — on a public repo, anyone could otherwise comment the mention
pattern and get a sandbox holding that repo's push credentials. Authorship is gated per
provider:

- **GitHub** trusts the event's own `author_association` — `OWNER`, `MEMBER`, `COLLABORATOR`
  (`agentSandbox.webhooks.trustedAssociations`). Maintainers need no configuration;
  `CONTRIBUTOR` and `NONE` are rejected. Applying the trigger label is trusted because GitHub
  already requires triage/write access for it.
- **Any provider** additionally trusts `agentSandbox.webhooks.allowUsers.<provider>` — an
  explicit list, for an outside collaborator who should be able to trigger runs.
- **GitLab/Slack/Jira** have no association field, so an empty list leaves them open (project
  and workspace membership gate those). The service logs a warning at startup for any enabled
  provider with no gate at all.

An untrusted author's comment is **dropped** — never forwarded, because text in the agent's
context window is the prompt-injection vector. Set `forwardUntrusted = true` to receive them
instead, wrapped in an explicit untrusted-content fence that the agent's skills tell it to
treat as data rather than instructions. Even then, an untrusted author can neither spawn a
conversation nor interrupt a run in progress.

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
