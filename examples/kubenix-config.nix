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

      # Datadog provider: proxies /datadog/* -> https://api.<site> with the two
      # keys injected, so the agent can query metrics/logs/monitors without
      # seeing them. Point the secrets at a Secret in the broker namespace.
      datadog = {
        enable = true;
        site = "datadoghq.com";
        apiKeySecret = { name = "datadog-keys"; key = "DATADOG_API_KEY"; };
        appKeySecret = { name = "datadog-keys"; key = "DATADOG_APP_KEY"; };
      };

      # AWS permissions broker: dynamic, approval-gated STS access per account. The
      # account registry is rendered into a ConfigMap; the broker pod carries a
      # checksum/aws-accounts annotation so editing an account auto-rolls the pod.
      aws = {
        enable = true;
        accounts.readonly-sandbox = {
          account_id = "123456789012";
          broker_role_arn = "arn:aws:iam::123456789012:role/agent-token-broker-base";
          enabled = true;
          description = "Sandbox account for safe read-only exploration (S3, logs).";
          auto_approve_read_only = true;
        };
      };
    };

    # Deployment-supplied sandbox extras (generic — the platform doesn't know what
    # they're for). `configFiles` mounts config FILES as a flat dir at
    # /etc/agent-sandbox/config; use it (not `env`) for multi-line config a tool
    # reads as a file — ConfigMap data is mounted byte-for-byte, sidestepping the
    # CRD controller's env-var newline corruption.
    deployTools.configFiles = {
      "nix.conf" = ''
        extra-substituters = http://atticd.nix-cache.svc.cluster.local:8080/itops
        extra-trusted-public-keys = itops:EXAMPLEKEY=
      '';
    };

    webhooks = {
      enable = true;
      testWebhook = true;
    };

    # Conversation UI (nginx serving assistant-ui + proxying the agent-host API).
    ui.enable = true;

    # Public ingress — a generic networking.k8s.io/v1 Ingress; bring your own
    # controller via className + annotations. The agent-host trusts an identity
    # header the ingress sets, so your AUTH + header-setting config goes in
    # `annotations` (here: an nginx external-auth + a forwarded header — adapt to
    # your controller, e.g. ALB cert-arn/scheme, an OIDC proxy, etc.).
    ingress = {
      enable = true;
      host = "chat.example.com";
      className = "nginx";
      annotations = {
        "cert-manager.io/cluster-issuer" = "letsencrypt";
        # Example: gate the UI/API behind an external auth service that injects
        # x-auth-user (the header the agent-host trusts). Replace for your setup.
        "nginx.ingress.kubernetes.io/auth-url" = "https://auth.example.com/verify";
        "nginx.ingress.kubernetes.io/auth-response-headers" = "x-auth-user,x-auth-email";
      };
      tls = true;
      tlsSecretName = "chat-tls";
    };

    # Webhooks receiver (GitHub/Slack/…): its own host + NO auth (providers sign
    # their requests). Generic ingress under agentSandbox.webhooks.ingress.
    webhooks.ingress = {
      enable = true;
      host = "scooter.example.com";
      className = "nginx";
      annotations."cert-manager.io/cluster-issuer" = "letsencrypt";
      tlsSecretName = "webhooks-tls";
    };
  };
}
