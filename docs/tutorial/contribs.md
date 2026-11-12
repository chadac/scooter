# Setting up contribs

Scooter's integrations are packaged as **contribs**: GitHub, GitLab, Slack, AWS, web
search, kanban boards and others. Each one adds some mix of broker routes, agent tools, skills, webhook
handlers and sandbox packages. This chapter turns on the common ones.

## How credentials work

Most contribs give the agent access to an external API. The credential never enters
the sandbox. It lives in a Kubernetes Secret that only the **broker** reads. When the
agent calls the API, the broker adds the credential to the outbound request:

```text
agent, in its sandbox
  │  agent-broker github/repos/acme/app
  ▼
broker
  │  adds the GitHub token
  ▼
api.github.com
```

So for each contrib you:

1. create a Secret in Scooter's namespace,
2. point the contrib at it by name and key, and
3. set `enable = true`.

Every contrib is **off until you enable it**. Enabling one also ships its skill, so the
agent learns how to use it (see [Customizing skills](skills.md)). Configuring a contrib
without enabling it is an error, not a silent no-op.

All of this needs the broker:

```nix
scooter.broker.enable = true;
```

The examples below use the `scooter` namespace from [Getting started](../getting-started.md).

## GitHub

The GitHub contrib gives the agent `git clone`/`push` over HTTPS and the GitHub API,
as a **GitHub App**. Commits and comments show up as the App, and you choose
exactly which repos it can reach.

1. Create a GitHub App (Settings → Developer settings → GitHub Apps → New). Grant it
   the repository permissions the agent needs: typically *Contents*, *Pull requests*
   and *Issues* (read and write), plus *Metadata* (read). Leave the webhook off for
   now; [Configuring webhooks](webhooks.md) covers it.
2. Generate a private key and install the App on your org or repos. Note the **App ID**
   (on the App's page) and the **installation ID** (the number at the end of the
   installation's settings URL).
3. Store the key:

    ```bash
    kubectl -n scooter create secret generic github-app-key \
      --from-file=private-key=./my-app.private-key.pem
    ```

4. Configure the contrib:

    ```nix
    contribs.github = {
      enable = true;
      appId = "123456";
      installationId = "7890123";
      privateKeySecret = { name = "github-app-key"; key = "private-key"; };
    };
    ```

5. To serve more than one account (your user and an org, say), install the App on
   each and list them. Each request then uses the installation on the account it
   names. A private App can only be installed on the account that owns it, so this
   needs a public App; `owners` makes sure installations on other accounts are
   never used and their webhooks are dropped.

    ```nix
    contribs.github.owners = [ "my-user" "my-org" ];
    ```

## GitLab

GitLab uses a token: a personal, group or project access token with the `api` scope.
The contrib currently targets `gitlab.com`.

```bash
kubectl -n scooter create secret generic gitlab-token \
  --from-literal=GITLAB_TOKEN=glpat-...
```

```nix
contribs.gitlab = {
  enable = true;
  tokenSecret.name = "gitlab-token";   # key defaults to GITLAB_TOKEN
};
```

To start conversations *from* GitLab comments and labels, also set up the
[GitLab webhook](webhooks.md#gitlab).

## Slack

Slack lets the agent post and read messages as a Slack app. Create an app at
<https://api.slack.com/apps>, add the bot scopes it needs (at least `chat:write`; the
[Slack webhook](webhooks.md#slack) section lists the rest), install it, and copy the
**Bot User OAuth Token** (`xoxb-…`).

```bash
kubectl -n scooter create secret generic slack-bot-token \
  --from-literal=SLACK_BOT_TOKEN=xoxb-...
```

```nix
contribs.slack = {
  enable = true;
  botTokenSecret.name = "slack-bot-token";
};
```

To start conversations *from* Slack mentions, also set up the
[Slack webhook](webhooks.md#slack).

## Web search

Three search contribs are available, and they can all run at once. Each adds its own
tool (`brave_web_search`, `kagi_web_search`, `duckduckgo_web_search`) and the agent picks
between them.

```nix
contribs = {
  duckduckgo.enable = true;                  # no key needed

  brave = {
    enable = true;
    apiKeySecret.name = "brave-search-key";  # key defaults to BRAVE_SEARCH_API_KEY
  };

  kagi = {
    enable = true;
    apiKeySecret.name = "kagi-search-key";   # key defaults to KAGI_API_KEY
  };
};
```

## Files and the VS Code editor

These two need no credentials. They add tools inside the sandbox.

```nix
contribs = {
  # A read-only file viewer in the browser. Reviewers can comment on lines, and
  # each comment wakes the agent.
  files.enable = true;

  # code-server (VS Code in the browser) inside the sandbox.
  code-server.enable = true;
};
```

For `files` comments to wake the agent, the conversation router's self-access
listener must be on:

```nix
scooter.conversationController.selfAccess.enable = true;
```

Without it, comments are stored but the agent isn't told about them.

## Observability: Grafana and Datadog

```nix
contribs = {
  # Proxies /grafana/* to your stack, with a service-account token added.
  grafana = {
    enable = true;
    url = "https://myorg.grafana.net";
    tokenSecret.name = "grafana-token";      # key defaults to GRAFANA_TOKEN
  };

  datadog = {
    enable = true;
    site = "datadoghq.eu";                   # default: datadoghq.com
    apiKeySecret.name = "datadog-keys";      # key: DATADOG_API_KEY
    appKeySecret.name = "datadog-keys";      # key: DATADOG_APP_KEY
  };
};
```

Grafana only mounts when both `url` and the token are set. Give the Grafana service
account the Viewer role unless you want the agent editing dashboards.

## AWS

The AWS contrib doesn't hand out standing credentials. The agent asks for scoped,
time-limited access to a named account, a human approves it in the conversation, and
the broker vends short-lived STS credentials into the sandbox.

It needs more setup than the others: an IRSA role for the broker, and in every account a
base role that the broker may assume.

```nix
contribs.aws = {
  enable = true;
  region = "us-east-1";
  # The broker's IRSA role, which each account's base role trusts.
  serviceAccountRoleArn = "arn:aws:iam::111111111111:role/scooter-broker";
  brokerPrincipalArn = "arn:aws:iam::111111111111:role/scooter-broker";

  accounts.sandbox = {
    account_id = "222222222222";
    broker_role_arn = "arn:aws:iam::222222222222:role/agent-token-broker-base";
    enabled = true;
    # The agent reads this to pick the right account, so always set it.
    description = "Sandbox account for read-only exploration (S3, CloudWatch logs).";
    # Grant read-only requests without a human (secret reads still need one).
    ruleSets = [ "read-only" ];
  };
};
```

The [`accounts` option](../reference/options/index.md) documents every per-account
field, including `allowed_policy` (the ceiling on what can ever be granted) and
`ruleSets` (what's granted without approval; secret reads always need one by
default).

## Atlassian (Jira and Confluence) and Airtable

```nix
contribs = {
  airtable = {
    enable = true;
    tokenSecret.name = "airtable-token";     # key defaults to AIRTABLE_TOKEN
  };

  atlassian = {
    enable = true;
    # One OAuth app (client credentials) for every product; keys default to
    # ATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET.
    credentialsSecret.name = "atlassian-oauth";
    cloudId = "…";                           # https://<site>/_edge/tenant_info
    siteUrl = "https://acme.atlassian.net";  # for /browse/{KEY} links
    # jira.enable and confluence.enable default to true.
  };
};
```

The broker's forge proxy intercepts `api.atlassian.com` and injects the app's
token into each enabled product's paths, so `curl` in the sandbox works against
the real URLs. Turning a product off stops the proxy authenticating it; the
app's scopes are still the upper limit. `jira.enable` also ships Jira's agent
tools, issue links and UI. Configure them here, not under `contribs.jira`.

To start conversations from Jira comments, see the [Jira webhook](webhooks.md#jira).

## Google Workspace

The `google` contrib proxies `/google/<host>/*` to `https://<host>.googleapis.com`
(Drive, Calendar, Docs, Sheets, Slides, Gmail, People, Tasks, Forms; any other host
is a 404) with a short-lived token minted from a service account.

```nix
contribs.google = {
  enable = true;
  serviceAccountSecret.name = "google-service-account";  # key defaults to GOOGLE_SERVICE_ACCOUNT_JSON
  subject = "agent@example.com";   # act as this Workspace user (domain-wide delegation)
  # or, per conversation: impersonateOwner = true; ownerDomains = [ "example.com" ];
  # scopes = [ ... ];              # default: read-only Drive/Docs/Sheets/Slides/Calendar/Gmail
};
```

Setup:

1. In a Google Cloud project, enable the APIs you want, create a service account,
   and download a JSON key. Store it as `GOOGLE_SERVICE_ACCOUNT_JSON` in a Secret in
   the broker namespace.
2. To act as a user (`subject` or `impersonateOwner`), a Workspace admin grants the
   service account's **client id** domain-wide delegation for exactly the configured
   scopes (Admin console → Security → API controls → Domain-wide delegation).
   Without delegation, leave `subject` empty, and the agent sees only what is
   shared with the service account's email.

`impersonateOwner` uses the conversation owner's email, so each user's agent sees
that user's own Drive, Calendar and mail. Owners outside `ownerDomains` get a 403
and never fall back to another identity. The scopes are the write gate: the
defaults are all `*.readonly`, and Google rejects writes with them.

## Kanban boards

Kanban shows a folder as a board at `/boards`, with each conversation in it as a card.
It needs no credentials, only the broker:

```nix
contribs.kanban = {
  enable = true;
  # Optional. The stages a new board starts with; users can change them per board.
  stages = [ "Design" "In progress" "Review" "Done" ];
  # Optional. Minutes before an untouched card reminds its agent to update it.
  staleAfter = 30;
};
```

Each board is a locked folder in the sidebar, with one locked folder inside it per
stage. A card's stage is the folder its conversation is filed in. Users can only file
conversations into these folders or take them out. The broker manages the folders
themselves, since it is the router's folder service by default
(`scooter.conversationController.folderServices`). The agent gets `kanban_*` tools and
a skill for keeping its card current. Cards can have tags, a priority, a description,
and other cards blocking them. A board can have skills, written under **Edit board**,
which every conversation filed on it gets as `board-<name>` skills through the
`kanban.board` skill provider.

Kanban keeps its boards in a database of its own, `contrib_kanban`, owned by the
broker's role. You don't create it yourself. On the next deploy:

1. The provisioning Job (`agent-postgres-init-<hash>`) creates the database and
   applies the table grants. It does this for the in-cluster server and for an
   `external` one.
2. The migration Job (`agent-db-migrate-<hash>`) waits up to 5 minutes for the
   database, then applies kanban's schema.

Check that both completed before you open `/boards`:

```bash
kubectl -n scooter get jobs
kubectl -n scooter logs job/<agent-postgres-init-…> --all-containers | tail
```

| Symptom | Likely cause |
|---|---|
| `/boards` is a 500, and the broker logs `database "contrib_kanban" does not exist` | The provisioning Job hasn't completed. Read its logs |
| The router logs `permission denied for table conversation_folders` (or another table) | Same: the grants come from the provisioning Job |
| The provisioning Job fails at `create secret … already exists` | Its ServiceAccount can't `get` one of the `agent-pg-*` Secrets. This happens if you replaced its Role with a list of `resourceNames`. List every consumer's Secret |
| Creating a board fails with `only a folder service can create a locked folder` | `folderServices` doesn't include `agent-broker` |

Each Job is named by a hash of its own spec. A fix outside that spec, such as a Role
change, keeps the name, so the failed Job isn't recreated. Delete it and apply again:

```bash
kubectl -n scooter delete job <agent-postgres-init-…> <agent-db-migrate-…>
```

With Argo CD, sync the app after deleting them. Completed Jobs delete themselves after
24 hours.

## Deploy and check

```bash
nix build && kubectl apply -f result
kubectl -n scooter rollout status deploy/agent-broker
```

Then start a conversation and try it: "list the open PRs on acme/app", or "search the web
for the kubenix docs". If a call fails, the agent sees the real HTTP status from the
broker. A `404` on a provider route means that contrib isn't enabled or its credential
didn't resolve, so check the broker's logs:

```bash
kubectl -n scooter logs deploy/agent-broker | grep -i <contrib>
```

[`examples/kubenix-config.nix`](https://github.com/chadac-me/scooter/blob/main/examples/kubenix-config.nix)
configures every shipped contrib, and CI renders it, so it is a reliable reference.

Next: [Configuring webhooks](webhooks.md).
