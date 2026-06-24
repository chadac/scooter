# Example platform configuration — a reference for deploying kubenix-agent-manager.
#
# This is a kubenix module that imports modules/platform.nix and sets the
# `agentSandbox.*` options with EVERY feature turned on (agent-host, broker,
# webhooks, UI, ingress, skills). Use it as a starting point for your own
# deployment, and read modules/platform.nix for the full option set.
#
# It's also what `just check-manifests` renders (see examples/check.nix) — so it
# doubles as a render check: if a change drops a resource or breaks eval, the
# example stops rendering and CI fails.
{ ... }:
{
  imports = [ ../modules/platform.nix ];

  kubenix.project = "agent-sandbox";
  kubernetes.version = "1.31";

  agentSandbox = {
    namespace = "agent-sandbox";

    # Images. registryPrefix expands to <prefix>agent-host:latest etc.; empty =
    # bare local names for kind/k3s. Per-image options override it.
    registryPrefix = "";
    pullPolicy = "IfNotPresent";

    # Real `goose acp` would need IRSA + a model; fakeAgent runs the dummy agent
    # so this example renders without cloud config.
    fakeAgent = true;

    agent = {
      name = "Scooter"; # the agent's user-facing identity
      provider = "aws_bedrock";
      model = "us.anthropic.claude-opus-4-6-v1";
      availableModels = [ "us.anthropic.claude-opus-4-6-v1" ];
      region = "us-east-1";

      # Skills injected into the agent as .goosehints (filename -> markdown).
      # Edit the ConfigMap to add/change a skill — no image rebuild.
      skills = {
        "example-repo.md" = ''
          ---
          name: example-repo
          ---
          The main repo is github.com/example/app. Clone it to get started:
          `git clone https://github.com/example/app` (git auth is brokered).
        '';
      };
    };

    broker = {
      enable = true;
      testProvider = true; # whoami + test git-credential transports
    };

    webhooks = {
      enable = true;
      testWebhook = true;
    };

    # Conversation UI (nginx serving assistant-ui + proxying the agent-host API).
    ui.enable = true;

    # Public ingress via Traefik (+ external-dns companion). Reuse a basic-auth
    # middleware since the agent-host API is otherwise unauthenticated.
    ingress = {
      enable = true;
      host = "chat.example.com";
      middlewares = [{ name = "basic-auth"; namespace = "agent-sandbox"; }];
    };
  };
}
