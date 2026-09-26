# Credential broker — Deployment + Service + RBAC.
#
# The broker authenticates sandbox pods via K8s TokenReview (so it needs a
# cluster-scoped ClusterRole granting `create tokenreviews`), then injects/vends
# credentials. See docs/BROKER.md + services/broker/.
#
# Sandboxes reach it at http://agent-broker.<ns>.svc.cluster.local:8080 and
# authenticate with their projected SA token (audience agent-broker), which the
# per-conversation Sandbox template already mounts (modules/conversation.nix).

{ config, lib, ... }:

let
  cfg = config.agentSandbox;
  bcfg = cfg.broker;

  # Static shares external origin + CSP allowlist. Both fall back to the public
  # ingress host so a deployment only has to set `shares.enable`; leaving them
  # empty (no explicit value AND no ingress host) makes the broker return
  # relative /s/<uuid>/ URLs and a `'self'` frame-ancestors default.
  sharesBaseUrl =
    if bcfg.shares.publicBaseUrl != "" then bcfg.shares.publicBaseUrl
    else if cfg.ingress.host != "" then "https://${cfg.ingress.host}"
    else "";
  sharesFrameAncestors =
    if bcfg.shares.frameAncestors != "" then bcfg.shares.frameAncestors
    else if cfg.ingress.host != "" then "https://${cfg.ingress.host}"
    else "";
in
{
  options.agentSandbox.broker = with lib; {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "Deploy the credential broker.";
    };
    image = mkOption {
      type = types.str;
      default = "${cfg.registryPrefix}agent-broker:latest";
      defaultText = literalExpression ''"''${registryPrefix}agent-broker:latest"'';
      description = "OCI ref of the broker image.";
    };
    testProvider = mkOption {
      type = types.bool;
      default = false;
      description = "Enable the `test` (whoami) provider for credential e2e tests.";
    };
    agentHostUrl = mkOption {
      type = types.str;
      default = "http://agent-host.${cfg.namespace}.svc.cluster.local:8080";
      description = ''
        Agent-host URL (AGENT_HOST_URL) — where the broker calls back to the
        platform: auto-linking a PR/issue an agent created, and raising an
        approval interrupt. Core, not per-feature: one cluster-internal URL, so a
        provider must read THIS rather than declare its own. Why: PR #636.
      '';
    };

    # --- How a contrib reaches the broker Deployment ------------------------
    # A contrib owns its own deployment config in contrib/<name>/deployment.nix
    # (imported by modules/platform.nix), but the Deployment is declared HERE.
    # These are the seams it contributes through — without them a contrib would
    # have to redeclare the container to add one env var. Why: #599.
    #
    # Lists, not attrsets, because that is the k8s shape; a contrib emits only
    # what its own `enable` gates, so a disabled one contributes nothing.
    extraEnv = mkOption {
      type = types.listOf (types.attrsOf types.anything);
      default = [ ];
      example = literalExpression ''[ { name = "AWS_ENABLED"; value = "true"; } ]'';
      description = ''
        Extra env entries appended to the broker container. A NAME declared twice
        is not an error here and k8s silently keeps the last value, so a contrib
        must own its prefix (examples/check.nix asserts the shared BROKER_DB_* set
        is never duplicated).
      '';
    };
    extraVolumes = mkOption {
      type = types.listOf (types.attrsOf types.anything);
      default = [ ];
      description = "Extra volumes on the broker pod (a contrib's ConfigMap mount).";
    };
    extraVolumeMounts = mkOption {
      type = types.listOf (types.attrsOf types.anything);
      default = [ ];
      description = "Extra volumeMounts on the broker container, paired with extraVolumes.";
    };
    podAnnotations = mkOption {
      type = types.attrsOf types.str;
      default = { };
      example = literalExpression ''{ "checksum/aws-accounts" = "…"; }'';
      description = ''
        Annotations on the broker POD TEMPLATE. The reason this seam exists at all:
        k8s rolls a Deployment only when the template mutates, so a contrib whose
        config lives in a mounted ConfigMap must hash it in here or the running
        process keeps reading the value it read at startup.
      '';
    };
    serviceAccountAnnotations = mkOption {
      type = types.attrsOf types.str;
      default = { };
      example = literalExpression ''{ "eks.amazonaws.com/role-arn" = "arn:aws:iam::…"; }'';
      description = "Annotations on the agent-broker ServiceAccount (IRSA and the like).";
    };
    jiraSiteUrl = mkOption {
      type = types.str;
      default = "";
      example = "https://acme.atlassian.net";
      description = ''
        The Jira SITE base URL, used to build a human /browse/{KEY} link when the
        broker auto-links an issue an agent creates via the Jira proxy (the
        create-issue API response carries no human URL). Empty -> auto-link uses
        the API `self` URL instead.
      '';
    };
    githubApp = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = "Enable the GitHub provider, backed by a GitHub App (vends installation tokens for git/HTTPS + the API).";
      };
      appId = mkOption {
        type = types.str;
        default = "";
        description = "GitHub App ID (GITHUB_APP_ID).";
      };
      installationId = mkOption {
        type = types.str;
        default = "";
        description = "GitHub App installation ID (GITHUB_APP_INSTALLATION_ID).";
      };
      privateKeySecret = mkOption {
        type = types.submodule {
          options = {
            name = mkOption { type = types.str; description = "Secret name (in the broker namespace)."; };
            key = mkOption { type = types.str; default = "private-key"; description = "Secret key holding the PEM."; };
          };
        };
        description = "Secret holding the GitHub App private key (PEM). The secret must exist in the broker namespace.";
      };
    };

    # --- Slack (static bot token; http-proxy to slack.com/api) --------------
    # The broker's slack provider proxies /slack/* -> https://slack.com/api,
    # injecting the bot token so the agent can chat.postMessage etc. WITHOUT ever
    # seeing the token. Enabled iff SLACK_BOT_TOKEN is set on the broker — hence
    # this option (without it the /slack/* routes never mount and the agent's
    # POST /slack/chat.postMessage 404s).
    slack = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = "Enable the Slack provider (http-proxy to slack.com/api with the bot token injected).";
      };
      botTokenSecret = mkOption {
        type = types.submodule {
          options = {
            name = mkOption { type = types.str; description = "Secret name (in the broker namespace)."; };
            key = mkOption { type = types.str; default = "SLACK_BOT_TOKEN"; description = "Secret key holding the Slack bot token."; };
          };
        };
        description = "Secret holding the Slack bot token (xoxb-…). Injected as SLACK_BOT_TOKEN. The secret must exist in the broker namespace.";
      };
    };

    # --- GitLab (static token; transparent http-proxy to gitlab.com) ----------
    # The broker's gitlab provider proxies /gitlab/<path> -> https://gitlab.com/<path>
    # (transparent, like github) — so agents call /gitlab/api/v4/... in full.
    # with the token injected (PRIVATE-TOKEN header), so the agent can comment on
    # MRs / create notes WITHOUT seeing the token. Enabled iff GITLAB_TOKEN is set
    # on the broker — hence this option (without it the /gitlab/* routes never
    # mount and the agent's calls 404).
    gitlab = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = "Enable the GitLab provider (transparent http-proxy to gitlab.com with the token injected).";
      };
      tokenSecret = mkOption {
        type = types.submodule {
          options = {
            name = mkOption { type = types.str; description = "Secret name (in the broker namespace)."; };
            key = mkOption { type = types.str; default = "GITLAB_TOKEN"; description = "Secret key holding the GitLab token."; };
          };
        };
        description = "Secret holding the GitLab token (glpat-…). Injected as GITLAB_TOKEN. The secret must exist in the broker namespace.";
      };
    };

    # --- Datadog (two-key header auth; http-proxy to api.<site>) --------------
    # The broker's datadog provider proxies /datadog/* -> https://api.<site> with
    # DD-API-KEY + DD-APPLICATION-KEY injected, so the agent can query
    # metrics/logs/monitors WITHOUT seeing the keys. Enabled iff BOTH keys are set
    # on the broker (without them the /datadog/* routes never mount and calls 404).
    datadog = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = "Enable the Datadog provider (http-proxy to api.<site> with the two keys injected).";
      };
      site = mkOption {
        type = types.str;
        default = "datadoghq.com";
        description = "Datadog site/region host suffix (datadoghq.com | datadoghq.eu | us3.datadoghq.com | us5.datadoghq.com | ap1.datadoghq.com | ddog-gov.com). Upstream is https://api.<site>.";
      };
      apiKeySecret = mkOption {
        type = types.submodule {
          options = {
            name = mkOption { type = types.str; description = "Secret name (in the broker namespace)."; };
            key = mkOption { type = types.str; default = "DATADOG_API_KEY"; description = "Secret key holding the Datadog API key."; };
          };
        };
        description = "Secret holding the Datadog API key. Injected as DATADOG_API_KEY. The secret must exist in the broker namespace.";
      };
      appKeySecret = mkOption {
        type = types.submodule {
          options = {
            name = mkOption { type = types.str; description = "Secret name (in the broker namespace)."; };
            key = mkOption { type = types.str; default = "DATADOG_APP_KEY"; description = "Secret key holding the Datadog application key."; };
          };
        };
        description = "Secret holding the Datadog application key. Injected as DATADOG_APP_KEY. The secret must exist in the broker namespace.";
      };
    };

    # --- Grafana (service-account token; http-proxy to a Grafana stack) -----
    # The broker's grafana provider proxies /grafana/* -> <url>, injecting the
    # token so the agent can query dashboards/datasources — and through Grafana's
    # datasource proxy, the Prometheus and Loki behind them — WITHOUT seeing the
    # token. Enabled iff BOTH url and the token secret are set (without them the
    # /grafana/* routes never mount and calls 404).
    grafana = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = "Enable the Grafana provider (http-proxy to a Grafana stack with a service-account token injected).";
      };
      url = mkOption {
        type = types.str;
        default = "";
        example = "https://myorg.grafana.net";
        description = "Base URL of the Grafana stack. Upstream for /grafana/*; a trailing slash is stripped.";
      };
      tokenSecret = mkOption {
        type = types.submodule {
          options = {
            name = mkOption { type = types.str; description = "Secret name (in the broker namespace)."; };
            key = mkOption { type = types.str; default = "GRAFANA_TOKEN"; description = "Secret key holding the Grafana service-account token."; };
          };
        };
        description = "Secret holding a Grafana service-account token. Injected as GRAFANA_TOKEN. The secret must exist in the broker namespace.";
      };
    };

    # --- Airtable (personal access token; http-proxy to api.airtable.com) ----
    # The broker's airtable provider proxies /airtable/* -> https://api.airtable.com
    # with the PAT injected, so the agent can read/write bases WITHOUT seeing the
    # token. Enabled iff the token secret is set (without it the /airtable/* routes
    # never mount and calls 404). There is no url option: Airtable is single-tenant
    # SaaS, so the upstream host is fixed. What the agent can reach is bounded by
    # the PAT's own scopes + base grants — scope it when you mint it, not here.
    airtable = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = "Enable the Airtable provider (http-proxy to api.airtable.com with a personal access token injected).";
      };
      tokenSecret = mkOption {
        type = types.submodule {
          options = {
            name = mkOption { type = types.str; description = "Secret name (in the broker namespace)."; };
            key = mkOption { type = types.str; default = "AIRTABLE_TOKEN"; description = "Secret key holding the Airtable personal access token."; };
          };
        };
        description = "Secret holding an Airtable personal access token (pat…). Injected as AIRTABLE_TOKEN. The secret must exist in the broker namespace.";
      };
    };

    # --- Static shares (broker/shares/) — persistent static webpages --------
    # The broker's shares feature lets agents publish static bundles, served at
    # /s/<uuid>/ and embeddable in the conversation UI. Off by default; when on,
    # the /shares + /s/<uuid>/ routes mount and the store persists to the shared
    # Postgres `broker` DB via the BROKER_DB_* components every broker store
    # shares —
    # there is deliberately NO SHARES_DB_DSN (setting it would pin the store to
    # the SQLite dev path and silently lose shares on restart). Without this
    # option the shares code ships in the image but the routes never mount.
    shares = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = "Enable static-share publishing (/shares + /s/<uuid>/). Persists to the shared Postgres `broker` DB.";
      };
      publicBaseUrl = mkOption {
        type = types.str;
        default = "";
        example = "https://scooter.example.com";
        description = ''
          External origin used to build the returned share URL
          (SHARES_PUBLIC_BASE_URL). Empty -> defaults to https://<ingress.host>
          when that is set, else a relative /s/<uuid>/ URL.
        '';
      };
      frameAncestors = mkOption {
        type = types.str;
        default = "";
        example = "https://scooter.example.com";
        description = ''
          CSP frame-ancestors allowlist for embedding a served share in an
          <iframe> (SHARES_FRAME_ANCESTORS) — the UI origin(s), space-separated.
          Empty -> defaults to https://<ingress.host> when set, else the broker's
          own `'self'` default (same-origin only).
        '';
      };
    };

    # --- OpenFGA authorization (the approver gate) --------------------------
    # SUBSTRATE, not a provider's: core/authz.py builds the authorizer from these
    # FGA_* settings and hands it to EVERY provider through BrokerContext (#624), so
    # this must not move back under one integration's options. Off -> NoopAuthorizer.
    # WHO may approve WHAT stays the provider's: the object half of a tuple
    # (`aws_account:<alias>`) is spelled by the code that knows what an account is.
    # Why: PR #636.
    fga = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = "Enforce approver authorization via OpenFGA. Deploys an openfga server.";
      };
      apiUrl = mkOption {
        type = types.str;
        default = "http://openfga.${cfg.namespace}.svc.cluster.local:8080";
        description = "OpenFGA HTTP API URL.";
      };
      storeId = mkOption {
        type = types.str;
        default = "";
        description = "OpenFGA store id (created out-of-band or by a seed step).";
      };
      authorizationModelId = mkOption {
        type = types.str;
        default = "";
        description = "OpenFGA authorization-model id (optional; latest used if empty).";
      };
      image = mkOption {
        type = types.str;
        default = "openfga/openfga:latest";
        description = "OpenFGA server image.";
      };
    };
  };

  # mkMerge: the table declarations are UNCONDITIONAL (see modules/db-spec.nix) —
  # the tables exist in lib/sql whether or not this deployment runs the service —
  # while everything else stays gated on `enable`. The gated body keeps its own
  # indentation so this wrapper is the whole diff.
  config = lib.mkMerge [
  # The tables the `broker` database holds (agentSandbox.db, #606). static_shares +
  # static_share_versions move into the shares CONTRIB module in stage 2 of #606 —
  # this is the declaration that moves, and nothing else changes when it does.
  {
    agentSandbox.db.broker = {
      owner = "broker";
      tables = {
        sandbox_size = { writers = [ "broker" ]; };
        permission_requests = { writers = [ "broker" ]; };
        module_registry = { writers = [ "broker" ]; };
        static_shares = { writers = [ "broker" ]; };
        static_share_versions = { writers = [ "broker" ]; };
      };
    };
  }
  (lib.mkIf bcfg.enable {
    # mkMerge (not //): the fga block and every contrib's deployment module each
    # add to `deployments`/`services`, and a shallow // would REPLACE those keys
    # (dropping agent-broker). mkMerge deep-merges so all of them coexist.
    kubernetes.resources = lib.mkMerge [
    {
      serviceAccounts.agent-broker = {
        metadata = {
          name = "agent-broker";
          namespace = cfg.namespace;
        } // lib.optionalAttrs (bcfg.serviceAccountAnnotations != { }) {
          # Contributed, e.g. IRSA (`eks.amazonaws.com/role-arn`) so the broker pod
          # can assume a cloud role. Emitted only when non-empty: an
          # `annotations = { }` key is not the same manifest as no key.
          annotations = bcfg.serviceAccountAnnotations;
        };
      };

      # TokenReview is cluster-scoped → ClusterRole + ClusterRoleBinding.
      clusterRoles.agent-broker-tokenreview = {
        metadata.name = "agent-broker-tokenreview";
        rules = [{
          apiGroups = [ "authentication.k8s.io" ];
          resources = [ "tokenreviews" ];
          verbs = [ "create" ];
        }];
      };

      clusterRoleBindings.agent-broker-tokenreview = {
        metadata.name = "agent-broker-tokenreview";
        roleRef = {
          apiGroup = "rbac.authorization.k8s.io";
          kind = "ClusterRole";
          name = "agent-broker-tokenreview";
        };
        subjects = [{
          kind = "ServiceAccount";
          name = "agent-broker";
          namespace = cfg.namespace;
        }];
      };

      deployments.agent-broker = {
        metadata = { name = "agent-broker"; namespace = cfg.namespace; };
        spec = {
          # Stateless (Postgres-backed; only an in-memory STS cache that re-vends on a
          # miss) — 2 replicas by default so consolidation can't take the broker down.
          replicas = cfg.statelessReplicas;
          selector.matchLabels.app = "agent-broker";
          template = {
            metadata = {
              labels.app = "agent-broker";
              # Roll the broker pod when its config content changes. K8s only
              # rolls a Deployment when the POD TEMPLATE mutates — a ConfigMap
              # content change alone doesn't (the mounted file updates in-place, but
              # the long-lived process has already read it, so it runs stale until a
              # manual `rollout restart`). Hashing the ConfigMap data into a pod
              # annotation mutates the template on any change → automatic rollout.
              # (Standard k8s pattern; Helm does this with sha256sum.) The hashes
              # come from whoever owns the ConfigMap — a contrib stamps its own
              # through broker.podAnnotations rather than this file listing them.
              annotations = bcfg.podAnnotations;
            };
            spec = {
              serviceAccountName = "agent-broker";
              containers.agent-broker = {
                name = "agent-broker";
                image = bcfg.image;
                imagePullPolicy = cfg.pullPolicy;
                command = [ "agent-broker" ];
                # A credential-vending service. 1Gi limit (not 512Mi): the broker holds
                # per-account STS cred caches + the provider registry, and 512Mi ran it
                # close enough that a liveness-kill during a DB-outage restart loop
                # looked like an OOM (exit 137). Give real headroom.
                resources = lib.mkDefault {
                  requests = { cpu = "50m"; memory = "256Mi"; };
                  limits = { memory = "1Gi"; };
                };
                ports = [{ containerPort = 8080; name = "http"; }];
                env = [
                  { name = "PORT"; value = "8080"; }
                  { name = "TOKEN_AUDIENCE"; value = "agent-broker"; }
                  { name = "SANDBOX_NAMESPACE"; value = cfg.namespace; }
                  { name = "TEST_PROVIDER_ENABLED"; value = lib.boolToString bcfg.testProvider; }
                  # Auto-linking: when an agent creates a PR/MR/issue via the proxy,
                  # the broker POSTs it to the agent-host /conversations/{id}/links.
                  { name = "AGENT_HOST_URL"; value = bcfg.agentHostUrl; }

                  # The shared platform `broker` database. Unconditional: the
                  # `broker` consumer is registered whenever the broker runs (see
                  # postgres.consumers below), so the role and its agent-pg-broker
                  # secret always exist — and EVERY broker store resolves its DSN
                  # from these. A store that finds no password falls back to a
                  # SQLite dev path and loses its data on restart without an error,
                  # so emitting these per-feature is the failure, not the saving.
                  { name = "BROKER_DB_HOST"; value = cfg.postgres.host; }
                  { name = "BROKER_DB_PORT"; value = toString cfg.postgres.port; }
                  { name = "BROKER_DB_NAME"; value = "broker"; }
                  { name = "BROKER_DB_USER"; value = "broker"; }
                  { name = "BROKER_DB_PASSWORD"; valueFrom.secretKeyRef = { name = "agent-pg-broker"; key = "password"; }; }

                  # The agent-host relays a user's action to the broker as itself, so
                  # core auth admits it as a non-sandbox caller and sets is_approver.
                  # Unconditional: TWO features read that flag — aws approve/deny and
                  # shares' cross-conversation listing — so gating the list on
                  # aws.enable made `shares` without `aws` 403 on the UI's own list
                  # request, with the agent-host looking like a stranger. It was
                  # AWS_APPROVER_SERVICE_ACCOUNTS for that reason. Why: #599.
                  { name = "APPROVER_SERVICE_ACCOUNTS"; value = "system:serviceaccount:${cfg.namespace}:agent-host"; }
                ] ++ lib.optional (cfg.postgres.sslmode != null)
                  { name = "BROKER_DB_SSLMODE"; value = cfg.postgres.sslmode; }
                ++ lib.optional (bcfg.jiraSiteUrl != "")
                  # Jira create-issue responses have no human URL; the broker builds
                  # <site>/browse/{KEY} from this to auto-link the created issue.
                  { name = "JIRA_SITE_URL"; value = bcfg.jiraSiteUrl; }
                ++ lib.optionals bcfg.githubApp.enable [
                  # GitHub App -> the broker's github provider vends installation
                  # tokens (git-credentials for HTTPS push + the API proxy). The
                  # private key (PEM) comes from a Secret in the broker namespace.
                  { name = "GITHUB_APP_ID"; value = bcfg.githubApp.appId; }
                  { name = "GITHUB_APP_INSTALLATION_ID"; value = bcfg.githubApp.installationId; }
                  {
                    name = "GITHUB_APP_PRIVATE_KEY";
                    valueFrom.secretKeyRef = {
                      name = bcfg.githubApp.privateKeySecret.name;
                      key = bcfg.githubApp.privateKeySecret.key;
                    };
                  }
                ] ++ lib.optionals bcfg.slack.enable [
                  # Slack bot token -> the broker's slack provider proxies
                  # /slack/* to slack.com/api with this injected. Without it the
                  # provider is disabled and /slack/chat.postMessage 404s.
                  {
                    name = "SLACK_BOT_TOKEN";
                    valueFrom.secretKeyRef = {
                      name = bcfg.slack.botTokenSecret.name;
                      key = bcfg.slack.botTokenSecret.key;
                    };
                  }
                ] ++ lib.optionals bcfg.gitlab.enable [
                  # GitLab token -> the broker's gitlab provider proxies /gitlab/*
                  # to gitlab.com with this injected. Without it the provider
                  # is disabled and the agent's /gitlab/* calls 404.
                  {
                    name = "GITLAB_TOKEN";
                    valueFrom.secretKeyRef = {
                      name = bcfg.gitlab.tokenSecret.name;
                      key = bcfg.gitlab.tokenSecret.key;
                    };
                  }
                ] ++ lib.optionals bcfg.datadog.enable [
                  # Datadog keys -> the broker's datadog provider proxies /datadog/*
                  # to https://api.<site> with both injected. Enabled iff BOTH keys
                  # are present; without them the /datadog/* routes never mount.
                  { name = "DATADOG_SITE"; value = bcfg.datadog.site; }
                  {
                    name = "DATADOG_API_KEY";
                    valueFrom.secretKeyRef = {
                      name = bcfg.datadog.apiKeySecret.name;
                      key = bcfg.datadog.apiKeySecret.key;
                    };
                  }
                  {
                    name = "DATADOG_APP_KEY";
                    valueFrom.secretKeyRef = {
                      name = bcfg.datadog.appKeySecret.name;
                      key = bcfg.datadog.appKeySecret.key;
                    };
                  }
                ] ++ lib.optionals bcfg.grafana.enable [
                  # Grafana service-account token -> the broker's grafana provider
                  # proxies /grafana/* to <url> with the token injected. Enabled iff
                  # BOTH url and token are present; without them the /grafana/*
                  # routes never mount and the agent's calls 404.
                  { name = "GRAFANA_URL"; value = bcfg.grafana.url; }
                  {
                    name = "GRAFANA_TOKEN";
                    valueFrom.secretKeyRef = {
                      name = bcfg.grafana.tokenSecret.name;
                      key = bcfg.grafana.tokenSecret.key;
                    };
                  }
                ] ++ lib.optionals bcfg.airtable.enable [
                  # Airtable PAT -> the broker's airtable provider proxies
                  # /airtable/* to api.airtable.com with the token injected.
                  # Without it the provider is disabled and the agent's
                  # /airtable/* calls 404.
                  {
                    name = "AIRTABLE_TOKEN";
                    valueFrom.secretKeyRef = {
                      name = bcfg.airtable.tokenSecret.name;
                      key = bcfg.airtable.tokenSecret.key;
                    };
                  }
                ] ++ lib.optionals bcfg.shares.enable ([
                  # Static shares -> the broker mounts /shares + /s/<uuid>/ and
                  # persists bundles in the shared Postgres `broker` DB. The store
                  # reuses the BROKER_DB_* components (StoreConfig builds a
                  # Postgres DSN whenever a db password is set), so SHARES_DB_DSN
                  # is deliberately left unset — setting it would pin the store to
                  # the SQLite dev path and silently lose shares on restart.
                  { name = "SHARES_ENABLED"; value = "true"; }
                ] ++ lib.optional (sharesBaseUrl != "")
                  { name = "SHARES_PUBLIC_BASE_URL"; value = sharesBaseUrl; }
                ++ lib.optional (sharesFrameAncestors != "")
                  { name = "SHARES_FRAME_ANCESTORS"; value = sharesFrameAncestors; }
                ) ++ lib.optionals bcfg.fga.enable [
                  # The authorizer core/authz.py builds and hands to every provider
                  # through BrokerContext — substrate, so it is emitted here rather
                  # than by the integration that happens to check a tuple.
                  { name = "FGA_ENABLED"; value = "true"; }
                  { name = "FGA_API_URL"; value = bcfg.fga.apiUrl; }
                  { name = "FGA_STORE_ID"; value = bcfg.fga.storeId; }
                  { name = "FGA_AUTHORIZATION_MODEL_ID"; value = bcfg.fga.authorizationModelId; }
                ]
                # Contribs last. A name emitted twice is silently the LAST value in
                # k8s, so examples/check.nix asserts this container declares no
                # duplicate env name at all — that check, not this ordering, is what
                # stops a contrib from quietly repointing BROKER_DB_HOST.
                ++ bcfg.extraEnv;
                volumeMounts = bcfg.extraVolumeMounts;
                readinessProbe.httpGet = { path = "/health"; port = "http"; };
                livenessProbe.httpGet = { path = "/health"; port = "http"; };
              };
              volumes = bcfg.extraVolumes;
            };
          };
        };
      };

      services.agent-broker = {
        metadata = { name = "agent-broker"; namespace = cfg.namespace; };
        spec = {
          selector.app = "agent-broker";
          ports = [{ port = 8080; targetPort = "http"; name = "http"; }];
        };
      };
    }
    (lib.mkIf bcfg.fga.enable {
      # OpenFGA authorization server — the broker's policy enforcement backend.
      # Uses the shared Postgres (agent-shared-db) as its datastore (a separate
      # `openfga` database). The broker seeds the model + approver tuples at
      # startup. (storeId/modelId are provided via broker.fga options once
      # created — e.g. by a one-time `fga store create` against this server.)
      deployments.openfga = {
        metadata = { name = "openfga"; namespace = cfg.namespace; };
        spec = {
          replicas = 1;
          selector.matchLabels.app = "openfga";
          template = {
            metadata.labels.app = "openfga";
            spec.containers.openfga = {
              name = "openfga";
              image = bcfg.fga.image;
              args = [ "run" ];
              env = [
                { name = "OPENFGA_DATASTORE_ENGINE"; value = "postgres"; }
                {
                  # postgres://openfga@host:5432/openfga — shared platform Postgres,
                  # OpenFGA's OWN db + auto-provisioned role (agent-pg-openfga).
                  name = "OPENFGA_DATASTORE_URI";
                  value = "postgres://openfga@${cfg.postgres.host}:${toString cfg.postgres.port}/openfga?sslmode=${if cfg.postgres.sslmode != null then cfg.postgres.sslmode else "disable"}";
                }
                {
                  name = "OPENFGA_DATASTORE_PASSWORD";
                  valueFrom.secretKeyRef = { name = "agent-pg-openfga"; key = "password"; };
                }
              ];
              ports = [
                { containerPort = 8080; name = "http"; }
                { containerPort = 8081; name = "grpc"; }
              ];
            };
          };
        };
      };

      services.openfga = {
        metadata = { name = "openfga"; namespace = cfg.namespace; };
        spec = {
          selector.app = "openfga";
          ports = [
            { port = 8080; targetPort = "http"; name = "http"; }
            { port = 8081; targetPort = "grpc"; name = "grpc"; }
          ];
        };
      };
    })
    ];

    # Register with the shared Postgres so the provisioning Job creates each db + a
    # dedicated owner role (agent-pg-broker / agent-pg-openfga). The `broker` db is
    # used by every store in the broker image — its own and any contrib's, which is
    # why the BROKER_DB_* env above is unconditional; openfga only when FGA is on.
    agentSandbox.postgres.consumers = lib.mkMerge [
      { broker = { db = "broker"; user = "broker"; }; }
      (lib.mkIf bcfg.fga.enable { openfga = { db = "openfga"; user = "openfga"; }; })
    ];
  })
  ];
}
