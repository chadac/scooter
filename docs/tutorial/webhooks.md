# Configuring webhooks

With webhooks, people can start and steer conversations from the tools they already
use. Mention the agent in a GitHub comment, add a label to a GitLab issue, or @-mention
it in Slack, and Scooter opens a conversation. Later comments on the same issue, PR or
thread go to that conversation, so a review round trip works like it would with a
human colleague.

Scooter ships webhook handlers for **GitHub**, **GitLab**, **Slack** and **Jira**.
Other sources, such as Confluence, have no handler yet; see
[Writing a contrib → Webhooks](writing-a-contrib/webhooks.md) to add one.

## How it works

The **webhooks service** receives each delivery at `POST /webhooks/<provider>`, checks
the provider's signature, then either:

- **starts a conversation**, when the event mentions the agent (`mentionPattern`) or adds
  the trigger label (`labelTrigger`), or
- **forwards the event** to the conversation already linked to that issue, PR or thread.

The conversation is attributed to the Scooter user with the same email address as the
person who triggered it. If there's no match, it has no owner.

The agent replies through the matching contrib's tools (`github_comment`,
`gitlab_comment`, `slack_respond`, `jira_comment`), so **each webhook needs its contrib
set up too**. See [Setting up contribs](contribs.md).

## 1. Turn on the service

The webhooks receiver needs its own **unauthenticated** hostname. Providers can't log
in through your auth proxy; they sign each request instead, and the handler checks the
signature itself. Don't put oauth2-proxy or any other auth middleware in front of this
host.

```nix
scooter.webhooks = {
  enable = true;

  # What a comment must contain to start a conversation. "@agent" by default.
  # GitHub only autocompletes real users, so a sigil like "!scooter" types more easily.
  mentionPattern = "!scooter";
  # The issue/PR label that starts a conversation (GitHub and GitLab).
  labelTrigger = "scooter";

  # Provider secrets. Each key in this Secret becomes an environment variable.
  secretName = "agent-webhooks-providers";

  ingress = {
    enable = true;
    host = "scooter-webhooks.example.com";
    className = "nginx";
    annotations."cert-manager.io/cluster-issuer" = "letsencrypt-prod";
  };
};
```

The "View conversation" links the agent posts point at `https://<scooter.ingress.host>`
by default. Override that with `scooter.webhooks.managerUrl`.

The provider secrets all live in **one** Secret, `secretName`. Its keys must be exactly
the environment variable names listed in each section below. Create it once, adding a key
for each provider you set up:

```bash
kubectl -n scooter create secret generic agent-webhooks-providers \
  --from-literal=GITHUB_WEBHOOK_SECRET="$(openssl rand -hex 32)"
```

To add a key later, edit the Secret and restart the service:

```bash
kubectl -n scooter edit secret agent-webhooks-providers
kubectl -n scooter rollout restart deploy/agent-webhooks
```

!!! warning "Always set the signing secret"
    A handler whose signing secret is unset **accepts every request unverified**.
    That's convenient for local testing, but in production anyone who can reach the
    webhooks host could then start conversations. Set the secret for every provider you
    enable.

## GitHub

**Triggers:** a mention in an issue or PR comment, a review or a review comment, or adding
the trigger label to an issue or PR. Once a conversation is linked, later comments and
reviews are forwarded to it, and so are CI results on its PRs (`workflow_run`: a failure, and the first success after one), a PR being merged or closed, and a PR starting to conflict with its base branch (`push`).

1. **Generate a webhook secret** and add it to the Secret as `GITHUB_WEBHOOK_SECRET`.

2. **Point GitHub at Scooter.** Use the GitHub App from
   [Setting up contribs](contribs.md#github), so one App covers the API and the
   webhooks. On the App's settings page:

    - **Webhook URL:** `https://scooter-webhooks.example.com/webhooks/github`
    - **Webhook secret:** the `GITHUB_WEBHOOK_SECRET` value
    - **Subscribe to events:** *Issues*, *Issue comment*, *Pull request*, *Pull request
      review*, *Pull request review comment*, *Push* and *Workflow run*

    A plain repository or org webhook works too (Settings → Webhooks, content type
    `application/json`, the same URL, secret and events).

3. **Ignore the agent's own comments.** The handler uses the contrib's App credentials
    to recognize the agent's own comments and ignore them. Without an `appId` it falls
    back to ignoring every bot comment that doesn't mention the agent
    (`ignoreBotAuthors`). To ignore other noisy bots, list them:

    ```nix
    scooter.webhooks.ignoreUsernames = [ "dependabot[bot]" "renovate[bot]" ];
    ```

4. **Test it:** comment `!scooter what does this repo do?` on an issue. The App's
   *Advanced* tab lists recent deliveries and their response codes.

## GitLab

**Triggers:** a mention in a comment on an issue or merge request, or adding the trigger
label to one. Later comments on a linked issue or MR are forwarded.

1. **Generate a token** and add it to the Secret as `GITLAB_WEBHOOK_SECRET`. GitLab sends
   it back verbatim in the `X-Gitlab-Token` header.

2. **Add the webhook** in the project or group: Settings → Webhooks.

    - **URL:** `https://scooter-webhooks.example.com/webhooks/gitlab`
    - **Secret token:** the `GITLAB_WEBHOOK_SECRET` value
    - **Triggers:** *Comments*, *Issues events* and *Merge request events*

3. **Ignore the agent's own comments.** GitLab payloads don't mark bot accounts, so
    add the agent's own GitLab user (the owner of `contribs.gitlab`'s token) and any
    other bots to `ignoreUsernames`, or the agent will hear its own comments:

    ```nix
    scooter.webhooks.ignoreUsernames = [ "scooter-bot" ];
    ```

4. **Test it** with GitLab's *Test → Note events* button, then with a real comment.

## Slack

**Triggers:** an @-mention of the app in a channel. Replies in a thread that already has a
conversation are forwarded to it, and so are attached images and files. Slack's native
mention event is used, so `mentionPattern` doesn't apply.

1. **Configure the app** from [Setting up contribs](contribs.md#slack) at
   <https://api.slack.com/apps>:

    - **OAuth & Permissions → Bot Token Scopes:** `app_mentions:read`, `chat:write`,
      `channels:history` (and `groups:history` for private channels), `files:read`,
      `users:read` and `users:read.email`. The last two are how Scooter maps a Slack
      user to a Scooter user.
    - **Event Subscriptions:** turn on, set the **Request URL** to
      `https://scooter-webhooks.example.com/webhooks/slack`, and subscribe to the bot
      events `app_mention` and `message.channels` (plus `message.groups` for private
      channels). Slack verifies the URL immediately, so deploy the service first.
    - **Interactivity & Shortcuts** (optional): turn on and set the **Request URL** to
      `https://scooter-webhooks.example.com/webhooks/slack/interactive`, so the conversation's
      owner can answer the agent's questions and approvals from the buttons in its thread.

    Reinstall the app after changing scopes.

2. **Add two keys to the Secret:** the app's **Signing Secret** (Basic Information) as
   `SLACK_SIGNING_SECRET`, and the bot token as `SLACK_BOT_TOKEN`. The webhooks service
   needs its own copy of the token to read threads and files.

3. **Test it:** invite the app to a channel and mention it.

## Jira

**Triggers:** a mention in an issue comment. Later comments on a linked issue are
forwarded.

!!! warning "Jira deliveries are not verified"
    The Jira handler doesn't check signatures yet, so anyone who can reach the webhooks
    host can post events to `/webhooks/jira`. Until it does, restrict that path at your
    ingress (for example, to Atlassian's published IP ranges) or leave Jira webhooks off.
    The fix is tracked in [#820](https://github.com/chadac-me/scooter/issues/820).

<!-- TODO(#820): the jira handler declares JIRA_WEBHOOK_SECRET but never checks it, has no
     jiraEnabled option (JIRA_ENABLED must come from the provider Secret), and its
     label trigger is hardcoded to "openhands" rather than labelTrigger. Fix those,
     then update this section. -->

1. **Turn it on** with `contribs.atlassian.jira.webhooksEnabled = true`, and add
   `JIRA_BOT_ACCOUNT_ID` to the Secret: the Atlassian account id the agent comments as,
   so its own comments are ignored.

2. **Add the webhook** in Jira: Settings → System → WebHooks → Create.

    - **URL:** `https://scooter-webhooks.example.com/webhooks/jira`
    - **Events:** *Comment created* and *Comment updated*, optionally narrowed with a
      JQL filter such as `project = ENG`

3. **Test it** by commenting `@agent summarize this issue` on an issue in scope.

## Troubleshooting

Check the receiver's logs first. Every delivery logs a `received event` line with its
source and event type.

```bash
kubectl -n scooter logs deploy/agent-webhooks -f
```

| Symptom | Likely cause |
|---|---|
| Provider shows a 401 | The signing secret is missing from the Secret or doesn't match the provider's, or the pod hasn't restarted since you changed it |
| Provider shows a 302 or a login page | An auth proxy is in front of the webhooks host |
| `{"status": "disabled"}` | The contrib's `webhooksEnabled` option is off |
| Delivered, but nothing happens | The comment doesn't contain `mentionPattern`, or its author is in `ignoreUsernames` |
| The agent replies to itself in a loop | GitLab: add its user to `ignoreUsernames`. GitHub: set `contribs.github.appId` |

For more detail, set `scooter.webhooks.logLevel = "DEBUG"`.

Next: [Writing a contrib](writing-a-contrib/index.md).
