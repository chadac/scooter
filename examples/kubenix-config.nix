# Example platform configuration: a kubenix module that imports
# modules/platform.nix and sets the `scooter.*` options with every feature on.
#
# Use it as a starting point for a deployment, and read modules/platform.nix for
# the full option set. It is also what `just check-manifests` renders through
# examples/check.nix, so a change that breaks eval or drops a resource fails CI.
{ buildPkgs, lib, ... }:
{
  # No platform.nix import: evalPlatform supplies it.

  kubenix.project = "agent-sandbox";
  kubernetes.version = "1.31";

  scooter = {
    namespace = "agent-sandbox";

    # The HS256 key for conversation tokens, created out-of-band with
    # `kubectl create secret generic agent-conv-token-secret --from-literal=secret=$(openssl rand -hex 32)`.
    convTokenSecret = "agent-conv-token-secret";

    # An empty registryPrefix means bare local image names for kind/k3s.
    registryPrefix = "";
    pullPolicy = "IfNotPresent";

    # The dummy agent lets this example render without cloud config.
    fakeAgent = true;

    # The scheduler reserves the full request per sandbox, so size this down on
    # small clusters.
    sandboxResources = {
      requests = { cpu = "2"; memory = "4Gi"; };
      limits = { cpu = "2"; memory = "4Gi"; };
    };

    agent = {
      name = "Scooter"; # the agent's user-facing identity
      provider = "aws_bedrock";
      # The model catalog keyed provider -> model id, each group marking its own
      # `default`, with `hint` guiding the agent's own model choice.
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
      testProvider = true; # the whoami test transport

      # The agent-facing MCP endpoint, on by default and stated here because the
      # coverage check requires the example to exercise every option namespace.
      mcp.enable = true;
    };

    # Config files mounted byte-for-byte as a flat dir at /etc/agent-sandbox/config.
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

    # Bring-your-own-Claude: deploys the controller, the unauthenticated /byoc
    # Ingress and the agent-host's remote-agent routes.
    byoc.enable = true;

    # Attachments up to 50MB, at most 4 per message. The ui nginx and (className
    # "nginx") the Ingress get the matching body limit.
    uploads = {
      maxFileBytes = 50 * 1024 * 1024;
      maxFilesPerMessage = 4;
    };

    # The agent-host trusts an identity header the ingress sets, so auth config
    # goes in `annotations`.
    ingress = {
      enable = true;
      host = "chat.example.com";
      className = "nginx";
      annotations = {
        "cert-manager.io/cluster-issuer" = "letsencrypt";
        # An external auth service that injects x-auth-user, the header the
        # agent-host trusts.
        "nginx.ingress.kubernetes.io/auth-url" = "https://auth.example.com/verify";
        "nginx.ingress.kubernetes.io/auth-response-headers" = "x-auth-user,x-auth-email";
      };
      tls = true;
      tlsSecretName = "chat-tls";
    };

    # Pre-warms overlay-upper PVCs so a fresh conversation finds common tools built.
    warmStore = {
      enable = true;
      goldenExpr = "nixpkgs#awscli2 nixpkgs#nodejs";
    };

    # The sandbox size menu: the only shapes the UI offers and the agent may
    # request, each rendered with requests == limits.
    sandboxSizes = {
      small = { cpu = "1"; memory = "2Gi"; hint = "A single service, small repos."; };
      # Exactly one preset carries `default = true`.
      medium = { cpu = "2"; memory = "4Gi"; hint = "Builds and test suites."; default = true; };
      large = { cpu = "4"; memory = "16Gi"; hint = "Parallel builds, large test runs."; };
      # Drop the GPU preset on a cluster with no GPU nodes.
      gpu-small = { cpu = "4"; memory = "16Gi"; gpu = 1; hint = "Local model inference."; };
    };

    # `replicas` is the agent-host floor the controller scales above, and
    # retentionMaxAgeMs = 0 disables auto-reaping.
    replicas = 2;
    statelessReplicas = 2;
    idleSuspendMs = 30 * 60 * 1000;
    retentionMaxAgeMs = 0;

    # Cron-style tasks that prompt a conversation; the relay key authenticates
    # the scheduler's calls into the agent-host.
    scheduler = {
      enable = true;
      tickSeconds = 30;
      relayKey = "change-me-or-provide-via-secret";
    };

    # Recurring commands the scheduler runs. An operator task is any derivation's
    # executable; it changes the scheduler image, so build and push that image too.
    systemTasks.broker-health = {
      command = lib.getExe (buildPkgs.writeShellApplication {
        name = "broker-health";
        runtimeInputs = [ buildPkgs.curl ];
        text = ''curl -fsS "$BROKER_URL/healthz" > /dev/null'';
      });
      every = "15m";
      timeout = "1m";
    };

    # On by default; shown so the render check exercises it.
    dbMigrate.enable = true;

    # The one-shot backfill Job (see modules/event-backfill.nix) is enabled here,
    # with the PVC retained as it requires, so the render check exercises it.
    eventBackfill.enable = true;
    conversationController.historyMirror.retainForMigration = true;
    # Sandbox self-access (VS Code continuing its own conversation), so the render check covers it.
    conversationController.selfAccess.enable = true;
    # Sandbox isolation is on by default; `enable = false` hands it to your own policies.
    networkPolicy.enable = true;
    networkPolicy.udpPorts = [ 53 10053 ];
    networkPolicy.tcpPorts = [ 53 10053 ];

    # OpenTelemetry metrics with per-model prices per million tokens.
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

    # The webhooks receiver gets its own host with no auth, since providers sign
    # their requests.
    webhooks.ingress = {
      enable = true;
      host = "scooter.example.com";
      className = "nginx";
      annotations."cert-manager.io/cluster-issuer" = "letsencrypt";
      tlsSecretName = "webhooks-tls";
    };
  };

  # --- Contribs: each integration's own options ---
  contribs = {
    # Opt in: `enable` defaults false, so a deployment names what it ships.
    aws.enable = true;
    ask-user.enable = true;
    airtable.enable = true;
    brave.enable = true;
    datadog.enable = true;
    duckduckgo.enable = true;
    github.enable = true;
    gitlab.enable = true;
    google.enable = true;
    grafana.enable = true;
    jira.enable = true;
    kagi.enable = true;
    # Static shares: agents publish bundles the broker serves at /s/<uuid>/.
    shares.enable = true;
    slack.enable = true;
    # Per-user SSH key: a broker-backed ssh-agent in each sandbox, a Settings tab.
    ssh.enable = true;

    # Datadog provider: proxies /datadog/* -> https://api.<site> with the two keys
    # injected from a Secret in the broker namespace.
    datadog = {
      site = "datadoghq.com";
      apiKeySecret = { name = "datadog-keys"; key = "DATADOG_API_KEY"; };
      appKeySecret = { name = "datadog-keys"; key = "DATADOG_APP_KEY"; };
    };

    # Airtable provider: proxies /airtable/* -> https://api.airtable.com with a
    # personal access token injected, bounded by the PAT's own scopes.
    airtable.tokenSecret = { name = "airtable-token"; key = "AIRTABLE_TOKEN"; };

    # Google provider: proxies /google/<host>/* -> https://<host>.googleapis.com
    # with a service-account token, impersonating `subject` (domain-wide delegation).
    google = {
      serviceAccountSecret.name = "google-service-account";
      subject = "agent@example.com";
    };

    # AWS permissions broker: approval-gated STS access per account, with the
    # registry rendered into a ConfigMap whose checksum annotation rolls the pod.
    aws.accounts.readonly-sandbox = {
      account_id = "123456789012";
      broker_role_arn = "arn:aws:iam::123456789012:role/agent-token-broker-base";
      enabled = true;
      description = "Sandbox account for safe read-only exploration (S3, logs).";
      ruleSets = [ "read-only" ];
    };

    # Both search providers: not exclusive, one tool each.
    brave.apiKeySecret = { name = "brave-search-key"; key = "BRAVE_SEARCH_API_KEY"; };
    kagi.apiKeySecret = { name = "kagi-search-key"; key = "KAGI_API_KEY"; };
    # duckduckgo is keyless, so shipping it is the whole config.

    # siteUrl only builds the human /browse/{KEY} link.
    jira.siteUrl = "https://example.atlassian.net";
    # Turns on /webhooks/jira; needs JIRA_WEBHOOK_SECRET in the webhooks Secret.
    jira.webhooksEnabled = true;

    # Mounts only when url and token both resolve.
    grafana = {
      url = "https://grafana.example.com";
      tokenSecret = { name = "grafana-token"; key = "GRAFANA_TOKEN"; };
    };

    # Token proxies: `name` has no default, so configure or drop.
    slack.botTokenSecret = { name = "slack-bot-token"; key = "SLACK_BOT_TOKEN"; };
    gitlab.tokenSecret = { name = "gitlab-token"; key = "GITLAB_TOKEN"; };
    # Users link their own GitLab account on Settings → GitLab.
    gitlab.userAuth = {
      enable = true;
      clientId = "0123456789abcdef";
      clientSecretSecret = { name = "gitlab-token"; key = "client-secret"; };
    };
    github = {
      appId = "123456";
      installationId = "7890123";
      owners = [ "my-user" "my-org" ];
      privateKeySecret = { name = "github-app-key"; key = "private-key"; };
      # Users link their own GitHub account on Settings → GitHub.
      userAuth = {
        enable = true;
        clientId = "Iv23liExample";
        clientSecretSecret = { name = "github-app-key"; key = "client-secret"; };
      };
    };
  };
}
