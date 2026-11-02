# Writing a contrib

Every Scooter integration is a **contrib**: a directory under `contrib/` that plugs into
the platform without editing any service's core. The integrations you set up in
[Setting up contribs](../contribs.md) are all built this way, so a new one has the
same reach they do.

This chapter builds one from scratch: **`acme`**, an integration for a made-up issue
tracker at `https://api.acme.example`. By the end, the agent can call the Acme API with a
token it never sees, comment on issues through a typed tool, and be started by a mention
in an Acme comment.

## Where a contrib lives

Contribs are built **into Scooter's images**. The broker image contains every contrib's
broker half, and the webhooks image contains every webhooks half. So a contrib lives in
the Scooter source tree, not in your deployment flake, and there are two ways to ship one:

- **Upstream it.** Open a PR against [chadac-me/scooter](https://github.com/chadac-me/scooter).
  Once it merges and CI publishes the images, any deployment can enable it.
- **Run a fork.** Add the contrib in your fork. The fork's `publish-images` workflow
  pushes images to `ghcr.io/<you>/scooter/`. Then point your deployment at the fork:

    ```nix
    # flake.nix
    inputs.scooter.url = "github:<you>/scooter";
    ```

    ```nix
    # scooter.nix
    scooter.registryPrefix = "ghcr.io/<you>/scooter/";
    ```

Either way, work inside the repo's dev shell (`nix develop`). See
[`CONTRIBUTING.md`](https://github.com/chadac-me/scooter/blob/main/CONTRIBUTING.md).

## The parts of a contrib

A contrib only needs the parts it uses. Most need just a declaration, a deployment half
and a broker provider.

| Part | File | What it does | Page |
|---|---|---|---|
| Declaration | `contrib.nix` | Names the contrib, declares its options and which services it plugs into | [Declaration](declaration.md) |
| Deployment half | `deployment.nix` | Turns the operator's options into Kubernetes config (env, Secrets, ConfigMaps) | [Deployment](deployment.md) |
| Broker provider | `broker_provider.py` | API routes in the broker, with the credential added | [Broker provider](broker.md) |
| Agent tools | `mcp_tools.py` | Typed tools the agent calls, such as `acme_comment` | [Agent tools](tools.md) |
| Skills | `skills/*.md` | Teach the agent how to use the integration | [Skills](skills.md) |
| Webhook handler | `webhooks_handler.py` | Start or steer conversations from the provider's events | [Webhooks](webhooks.md) |
| Sandbox module | `sandbox.nix` | Packages and services inside the agent's sandbox | [Sandbox](sandbox.md) |
| UI metadata | in `contrib.nix` | Brand icon and tool cards in the chat UI | [UI](ui.md) |
| Tests | `tests/` | Run in the package build, and in CI | [Testing and shipping](testing.md) |

When it's finished, `acme` looks like this:

```text
contrib/acme/
├── contrib.nix                  # declaration + options + UI metadata
├── deployment.nix               # kubenix: options -> broker/webhooks env
├── icon.svg
├── skills/
│   └── scooter-acme.md
├── scooter_contrib_acme/
│   ├── __init__.py              # imports neither service
│   ├── config.py                # settings read from env
│   ├── broker_provider.py       # loaded only in the broker image
│   ├── mcp_tools.py             # agent tools, served by the broker
│   └── webhooks_handler.py      # loaded only in the webhooks image
└── tests/
    └── test_acme.py
```

## Worked examples in the tree

Read these alongside the chapter:

- **`contrib/airtable`**, the smallest real contrib: one token, one proxy, one skill.
- **`contrib/echo`**, the reference fixture. It uses every seam (broker, webhooks,
  tools, approvals, sandbox) but ships nowhere.
- **`contrib/github`** and **`contrib/gitlab`**, complete integrations with tools,
  webhooks and auto-linking.
- **`contrib/aws`**, with all three halves, including human approvals.
- **`contrib/README.md`**, the design reference. It explains *why* the seams are shaped
  the way they are.

Start with the [declaration](declaration.md).
