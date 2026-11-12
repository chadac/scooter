# Getting started

Scooter deploys as a set of Kubernetes manifests rendered by [kubenix](https://kubenix.org/)
from one typed configuration module. You describe the platform in Nix: which services run,
which models the agent may use, which integrations it gets. Scooter renders the
Deployments, Services, RBAC and database setup from that, pinned to the images CI has
published.

This guide takes you from an empty cluster to a running deployment, then walks through
the options most deployments change.

!!! tip "Just want to try it?"
    [Local deployments](tutorial/deploying/local.md): `nix run github:chadac-me/scooter#local -- up`
    brings up a throwaway cluster on your laptop and deploys Scooter into it. Nothing
    below is needed until you deploy for other people.

## Prerequisites

- **A Kubernetes cluster** (k3s, kind, EKS, …) with the
  [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller installed.
  Scooter creates one `Sandbox` per conversation; the controller turns it into a pod.
- **A CNI that enforces NetworkPolicy** (k3s's built-in controller, Calico, Cilium, …).
  Scooter isolates sandbox pods with a NetworkPolicy that uses port ranges (`endPort`),
  which all three support.
- **Nix with flakes enabled**, on the machine you deploy from.
- **An ingress controller** (nginx, Traefik, …), so the UI is reachable from a browser.
- **An authenticating proxy** in front of the UI, such as
  [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/). Scooter does no login of
  its own; see [Authentication](#authentication).
- **A model provider**: AWS Bedrock, or a Claude subscription. See [Models](#models).

## 1. Create a deployment flake

Your deployment lives in its own repository, as a flake that takes Scooter as an input:

```nix
# flake.nix
{
  inputs = {
    scooter.url = "github:chadac-me/scooter";
    nixpkgs.follows = "scooter/nixpkgs";
    flake-parts.follows = "scooter/flake-parts";
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      perSystem = { system, ... }: {
        packages.default =
          (inputs.scooter.lib.evalPlatform {
            inherit system;
            module = ./scooter.nix;
          }).config.kubernetes.result;
      };
    };
}
```

`evalPlatform` is Scooter's entry point. It loads the platform modules and the image
definitions, so every image reference resolves to a content-addressed tag on
`ghcr.io/chadac-me/scooter`. You don't build any images yourself.

## 2. Write a minimal configuration

```nix
# scooter.nix
{
  scooter = {
    namespace = "scooter";

    # The chat UI, plus the broker that holds credentials on the agent's behalf.
    ui.enable = true;
    broker.enable = true;

    ingress = {
      enable = true;
      host = "scooter.example.com";
      className = "nginx";
    };

    # Claude via AWS Bedrock (the default provider), authenticated with an IRSA role
    # whose trust policy allows system:serviceaccount:scooter:agent-host.
    agent.availableModels.goose."us.anthropic.claude-sonnet-4-6".default = true;
    serviceAccountRoleArn = "arn:aws:iam::123456789012:role/scooter-agent-host";
  };
}
```

`scooter.nix` is an ordinary NixOS-style module: it can take `{ lib, ... }:`, use
`lib.mkForce`, import other files, and so on.

## 3. Create the secrets

Scooter never puts secret values in the rendered manifests. Secrets are created
out-of-band, and the config refers to them by name. The minimal configuration needs one,
the key that signs conversation tokens:

```bash
kubectl create namespace scooter
kubectl -n scooter create secret generic agent-conv-token-secret \
  --from-literal=secret="$(openssl rand -hex 32)"
```

Each feature below lists any secret it needs in the same way.

## 4. Render and deploy

```bash
nix build                  # renders ./result
kubectl apply -f result
kubectl -n scooter rollout status deploy/agent-host
```

Open `https://scooter.example.com` and start a conversation. To upgrade, run
`nix flake update scooter` and apply again.

This is fine for trying Scooter out. For a deployment a team relies on, see
[Deploying Scooter](tutorial/deploying/index.md): deploying from GitHub Actions, checking
images exist before you apply, weekly updates, and running your own images.

## Common options

Every option is listed with its type and default in the
[configuration reference](reference/options/index.md). These are the ones most
deployments touch.

### Authentication

Scooter reads the user from an identity header set by the proxy in front of it, and
confirms each browser session with that proxy's forward-auth endpoint, refusing any
request it can't attribute to a signed-in user. Any proxy with such an endpoint works
(oauth2-proxy, Authelia, Pomerium, …), as long as it returns the user in
`X-Auth-Request-User`. The example below uses oauth2-proxy. **Only expose Scooter through a proxy
that sets these headers and strips any copies the client sends.**

```nix
scooter.auth = {
  mode = "header";                  # or "alb-oidc" behind an AWS ALB (then set albRegion)
  userHeader = "x-forwarded-user";  # the header your proxy sets
  emailHeader = "x-forwarded-email";
  # Your proxy's forward-auth endpoint (oauth2-proxy: set_xauthrequest = true).
  sessionCheckUrl = "http://oauth2-proxy.scooter.svc.cluster.local/oauth2/auth";
};
```

Rendered resources can be changed like any other kubenix config. For example, to route
the UI's ingress through oauth2-proxy instead of straight to the UI:

```nix
kubernetes.resources.ingresses.agent-host.spec.rules = lib.mkForce [{
  host = "scooter.example.com";
  http.paths = [{
    path = "/"; pathType = "Prefix";
    backend.service = { name = "oauth2-proxy"; port.number = 80; };
  }];
}];
```

### TLS

```nix
scooter.ingress = {
  tls = true;
  tlsSecretName = "scooter-tls";
  annotations."cert-manager.io/cluster-issuer" = "letsencrypt-prod";
};
```

### Models

The model catalog is keyed by provider, then model id. Each provider marks one
`default`, and the `hint` tells the agent when to switch to that model.

```nix
scooter.agent.availableModels.goose = {
  "us.anthropic.claude-sonnet-4-6" = {
    default = true;
    hint = "Fast and cheap: simple edits, CI fixes.";
  };
  "us.anthropic.claude-opus-4-8".hint = "Slow and powerful: design, hard debugging.";
};
```

To run on a **Claude subscription** instead of Bedrock, use the `claude-code` provider.
It needs the `agent-host-claude` image and a token from `claude setup-token`:

```nix
scooter.agent = {
  provider = "claude-code";
  claudeCode.tokenSecret = "agent-claude-code-token";
  availableModels."claude-code"."claude-sonnet-4-6".default = true;
};
```

Run `claude setup-token`, copy the `sk-ant-oat01-…` token it prints, then:

```bash
kubectl -n scooter create secret generic agent-claude-code-token \
  --from-literal=token='sk-ant-oat01-…'
```

<!-- TODO: the agent-host-claude image currently has to be pinned by hand
     (scooter.images.agent-host.ref); document it properly once publishedAs lands. -->

Users can also connect their own Claude subscription from their laptop with
[bring-your-own-Claude](features/byoc.md) (`scooter.byoc.enable = true`).

### Integrations and webhooks

Integrations such as GitHub, Slack and web search are **contribs**, and each is off until
you enable it. [Setting up contribs](tutorial/contribs.md) walks through them, and
[Configuring webhooks](tutorial/webhooks.md) shows how to start conversations from
GitHub, GitLab, Slack and Jira.

### Scheduled tasks

```nix
scooter.scheduler.enable = true;
```

This turns on the scheduled-tasks page and lets the agent schedule its own recurring
work.

### Sandboxes

```nix
scooter = {
  # The sizes the UI offers and the agent may request. Exactly one is the default.
  sandboxSizes = {
    small  = { cpu = "1"; memory = "2Gi";  hint = "Small repos."; };
    medium = { cpu = "2"; memory = "4Gi";  hint = "Builds and test suites."; default = true; };
    large  = { cpu = "4"; memory = "16Gi"; hint = "Parallel builds."; };
  };
  idleSuspendMs = 30 * 60 * 1000;  # suspend after 30 idle minutes
  sandboxRuntimeClass = "crun";    # optional; lets systemd run without privileges
  # Pre-warmed Nix stores, so new conversations start with common tools built.
  warmStore = { enable = true; goldenExpr = "nixpkgs#jq nixpkgs#nodejs"; };
};
```

### Storage on single-node clusters

The agent-host stores uploaded files on a volume shared by all its replicas, so it needs
`ReadWriteMany`. Provisioners like k3s's `local-path` only support `ReadWriteOnce`, so on
those clusters use a host path instead:

```nix
scooter.conversationController = {
  assets.hostPath = "/var/lib/scooter/agent-host-assets";

  # Conversation history lives in Postgres. This turns off a leftover volume that
  # nothing uses, which would otherwise sit Pending without RWX (#825).
  historyMirror.enable = false;
};
```

This only works while every agent-host pod runs on the same node.

## Next steps

The rest of the tutorial builds on this deployment:

1. [Deploying Scooter](tutorial/deploying/index.md): deploy from CI, keep it updated, and
   run custom images.
2. [Customizing skills](tutorial/skills.md): include Scooter's platform skills and teach
   the agent about your repos.
3. [Setting up contribs](tutorial/contribs.md): GitHub, GitLab, Slack, search, AWS and
   more.
4. [Configuring webhooks](tutorial/webhooks.md): start conversations from comments,
   labels and mentions.
5. [Writing a contrib](tutorial/writing-a-contrib/index.md): add an integration of your
   own.

Also useful:

- [`examples/kubenix-config.nix`](https://github.com/chadac-me/scooter/blob/main/examples/kubenix-config.nix)
  is a kitchen-sink example with every feature on. CI renders it, so it always evaluates.
- The [configuration reference](reference/options/index.md) documents every option.
- [Features](features/index.md) explains what each part of Scooter does.
