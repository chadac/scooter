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

    # Per-sandbox pod sizing. Omit (null) for the same Guaranteed default shown
    # here — the scheduler RESERVES the full request per sandbox, so on small
    # clusters (CI runners) size this down or a second concurrent sandbox never
    # schedules (Insufficient cpu). An idle sandbox measures ~0 CPU / ~40Mi.
    sandboxResources = {
      requests = { cpu = "2"; memory = "4Gi"; };
      limits = { cpu = "2"; memory = "4Gi"; };
    };

    agent = {
      name = "Scooter"; # the agent's user-facing identity
      provider = "aws_bedrock";
      # The model catalog, PROVIDER-FIRST: provider -> model id -> options. Model ids are
      # provider-specific namespaces (Bedrock ids under "goose"; API ids under "claude-code" /
      # "byoc"), so the provider is the outer key and each group marks its own `default`.
      # `hint` guides the agent's own model choice (surfaced by the list_models MCP tool).
      availableModels = {
        goose = {
          "us.anthropic.claude-sonnet-4-6" = {
            default = true;
            hint = "Fast + cheap. Use for simple edits, config/CI fixes, straightforward PRs.";
          };
          "us.anthropic.claude-opus-4-8" = {
            hint = "Slow + powerful. Escalate for architecture, novel implementations, hard debugging.";
          };
        };
        # The user's own container runs API ids, never Bedrock ids.
        byoc."claude-sonnet-4-5" = { default = true; hint = "The user's own subscription."; };
      };
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

      # Static shares: agents publish static bundles the broker serves at
      # /s/<uuid>/ and the UI embeds. Persists to the shared Postgres `broker` DB.
      # publicBaseUrl/frameAncestors default to https://<ingress.host>.
      shares.enable = true;
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

    # Bring-your-own-Claude: ONE knob. This deploys the BYOC controller, exposes /byoc on the
    # UI's ingress host (a separate, deliberately UNAUTHENTICATED Ingress object — the container
    # has no browser session; the join token, then its device key, is the gate), enables the
    # agent-host's remote-agent routes + Settings UI, and derives the public URL the container
    # dials. Override byoc.ingress.host for a dedicated hostname.
    byoc.enable = true;

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

    # Warm /nix/store PVC pool controller: pre-warms overlay-upper PVCs so a fresh
    # conversation finds common tools already built. Off in prod by default (the pool
    # is a hit-rate optimization, not a correctness dependency); enabled here so the
    # render check exercises its Deployment + RBAC.
    warmStore = {
      enable = true;
      goldenExpr = "nixpkgs#awscli2 nixpkgs#nodejs";
    };

    # Fleet sizing + lifecycle. `replicas` is the agent-host floor (the conversation
    # controller autoscales above it to fit live demand); `statelessReplicas` sizes the
    # stateless services (router/UI). An idle conversation suspends after idleSuspendMs —
    # its sandbox pod goes away, the Sandbox object and volumes remain, and the next prompt
    # revives it with its transcript. retentionMaxAgeMs = 0 disables destructive auto-reaping
    # (starred conversations are exempt from it regardless).
    replicas = 2;
    statelessReplicas = 2;
    idleSuspendMs = 30 * 60 * 1000;
    retentionMaxAgeMs = 0;

    # Scheduled runs: cron-style tasks that prompt a conversation on a timer. The relay key
    # authenticates the scheduler's calls into the agent-host (create it out-of-band; empty
    # here would disable the relay). Scheduled runs deliberately never consume a user's
    # personal BYO subscription — they take the platform's floor model.
    scheduler = {
      enable = true;
      tickSeconds = 30;
      relayKey = "change-me-or-provide-via-secret";
    };

    # Shared-database migrations: on deploy, a Job applies the Atlas migrations under
    # lib/sql to each per-service database (adopting the existing tables via
    # --baseline). On by default; shown explicitly so the render check exercises it.
    dbMigrate.enable = true;

    # One-shot event-log backfill: a Job that loads conversation history off the mirror PVC
    # into Postgres during the PVC→DB cutover. EPHEMERAL — a real deploy turns this ON only for
    # the migration, verifies the report, then turns it OFF (see modules/event-backfill.nix).
    # Enabled here (with the PVC retained, which the assert requires) so the render check
    # exercises the Job + its DB wiring; the historyMirror is on by default.
    eventBackfill.enable = true;
    conversationController.historyMirror.retainForMigration = true;

    # OpenTelemetry metrics + per-model cost attribution. OFF by default (an OTLP endpoint is
    # a deployment choice); enabled here so the render check exercises the env wiring. Prices
    # are per MILLION tokens and feed the cost metric — keep them in sync with your provider.
    observability.otel = {
      enable = true;
      environment = "example";
      env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel-collector.observability:4317";
      pricing."us.anthropic.claude-sonnet-4-6" = {
        inputPerMillion = 3.0;
        outputPerMillion = 15.0;
        cachedReadPerMillion = 0.3;
        cachedWritePerMillion = 3.75;
      };
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
