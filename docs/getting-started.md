# Getting started

Scooter deploys as a set of Kubernetes manifests rendered by [kubenix](https://kubenix.org/)
from one typed configuration module. You describe the platform in Nix; everything else —
images, Deployments, the option reference in these docs — derives from that.

## Prerequisites

- A Kubernetes cluster (k3s, kind, EKS, …) with the
  [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller installed
- Nix with flakes enabled
- An ingress controller if you want the UI reachable from a browser

## Minimal configuration

```nix
# platform.nix
{
  agentSandbox = {
    namespace = "agent-sandbox";

    # The chat UI + API, behind your ingress (auth is YOUR ingress's job — Scooter
    # trusts the identity header it sets).
    ui.enable = true;
    ingress = {
      enable = true;
      host = "chat.example.com";
      className = "nginx";
    };

    # The model catalog. See the option reference for the provider-first layout.
    agent.availableModels = {
      goose."us.anthropic.claude-sonnet-4-6" = { default = true; };
    };

    # Bring-your-own-Claude: one option enables the controller, its ingress path,
    # and the Settings UI.
    byoc.enable = true;
  };
}
```

Render and apply:

```bash
nix build .#platform-manifests   # or wire mkPlatform into your own flake
kubectl apply -f result
```

The full set of options — every `agentSandbox.*` knob with types, defaults, and
examples — is in the [configuration reference](reference/options/index.md), generated
directly from the modules so it cannot drift from the code.

!!! note "Example configuration"
    [`examples/kubenix-config.nix`](https://github.com/chadac/scooter/blob/main/examples/kubenix-config.nix)
    is the maintained kitchen-sink example — every feature enabled, with comments. It doubles
    as the render-check fixture in CI, so it always evaluates.
