# Credential broker: Deployment, Service and RBAC.
#
# The broker authenticates sandbox pods via K8s TokenReview (hence the
# cluster-scoped `create tokenreviews` ClusterRole) and then vends credentials;
# see docs/BROKER.md and services/broker/. Sandboxes reach it at
# http://agent-broker.<ns>.svc.cluster.local:8080 with the projected SA token
# (audience agent-broker) that modules/conversation.nix mounts.

{ config, lib, ... }:

let
  cfg = config.scooter;
  bcfg = cfg.broker;
in
{
  options.scooter.broker = with lib; {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "Deploy the credential broker.";
    };
    image = mkOption {
      type = types.str;
      default = cfg.images.agent-broker.ref.fullUrl;
      defaultText = literalExpression "config.scooter.images.agent-broker.ref.fullUrl";
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
    # A contrib's deployment.nix adds env, volumes and annotations to the
    # Deployment declared here through these seams, gated on its own `enable`.
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
    # The agent-facing MCP endpoint.
    mcp = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = ''
          Serve the agent-facing MCP endpoint (`POST /mcp`) — the contrib-contributed
          agent tools, scoped to ONE conversation per request by a conversation token
          (an allowlisted control-plane SA token plus a signed conversation token, or a
          sandbox's own SA). See issue #700.

          ON by default. The tool set is whatever the ENABLED providers contribute, so a
          deployment with no tool-bearing contrib serves an endpoint with an empty
          `tools/list` — which costs nothing, because the endpoint being served is a
          separate question from it being OFFERED to the agent. Nothing offers it yet;
          that lands with the provider tools in phase 2.
        '';
      };
    };
    # --- The forge egress proxy (broker/forge/) -----------------------------
    # Sandbox git/`gh`/`glab` traffic to the forges (GitHub, GitLab) goes through a
    # broker-side CONNECT proxy that terminates TLS for those hosts and injects the
    # provider credential, so the token never enters the sandbox. The broker creates
    # its CA (Secret `scooter-forge-ca`, never mounted in a sandbox) and publishes the
    # public cert and host list (ConfigMap `scooter-forge-ca`), which each sandbox
    # mounts and trusts; the CA's name constraints limit it to the forge hosts.
    forgeProxy = {
      port = mkOption {
        type = types.port;
        default = 3128;
        description = "Port of the forge proxy listener on the broker pod and Service.";
      };
    };

    # --- OpenFGA authorization (the approver gate) --------------------------
    # core/authz.py builds the authorizer from these settings and hands it to every
    # provider through BrokerContext; off means NoopAuthorizer.
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

  # The table declarations are unconditional (see modules/db-spec.nix); everything
  # else is gated on `enable`.
  config = lib.mkMerge [

  # The tables the `broker` database holds; the owner is declared here and tables
  # merge in from wherever the code that writes them lives.
  {
    scooter.db.broker = {
      owner = "broker";
      tables = {
        sandbox_size = { writers = [ "broker" ]; };
      };
    };
  }
  (lib.mkIf bcfg.enable {
    # Deep-merged so the fga block and the contribs' additions to
    # `deployments`/`services` coexist.
    kubernetes.resources = lib.mkMerge [
    {
      serviceAccounts.agent-broker = {
        metadata = {
          name = "agent-broker";
          namespace = cfg.namespace;
        } // lib.optionalAttrs (bcfg.serviceAccountAnnotations != { }) {
          # Emitted only when non-empty, since an empty `annotations` key is a
          # different manifest from no key.
          annotations = bcfg.serviceAccountAnnotations;
        };
      };

      # TokenReview is cluster-scoped, so this is a ClusterRole.
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
          # Stateless apart from an in-memory STS cache that re-vends on a miss.
          replicas = cfg.statelessReplicas;
          selector.matchLabels.app = "agent-broker";
          template = {
            metadata = {
              labels.app = "agent-broker";
              # Contribs stamp a hash of their ConfigMap here so a config change
              # mutates the pod template and rolls the Deployment.
              annotations = bcfg.podAnnotations;
            };
            spec = {
              serviceAccountName = "agent-broker";
              containers.agent-broker = {
                name = "agent-broker";
                image = bcfg.image;
                imagePullPolicy = cfg.pullPolicy;
                command = [ "agent-broker" ];
                # The per-account STS caches and provider registry need headroom
                # above the request.
                resources = lib.mkDefault {
                  requests = { cpu = "50m"; memory = "256Mi"; };
                  limits = { memory = "1Gi"; };
                };
                ports = [
                  { containerPort = 8080; name = "http"; }
                  { containerPort = bcfg.forgeProxy.port; name = "forge-proxy"; }
                ];
                env = [
                  { name = "PORT"; value = "8080"; }
                  { name = "TOKEN_AUDIENCE"; value = "agent-broker"; }
                  { name = "SANDBOX_NAMESPACE"; value = cfg.namespace; }
                  { name = "TEST_PROVIDER_ENABLED"; value = lib.boolToString bcfg.testProvider; }
                  # Where the broker POSTs auto-linked PRs/issues and approval
                  # interrupts.
                  { name = "AGENT_HOST_URL"; value = bcfg.agentHostUrl; }
                  # The token the router checks on those calls.
                  { name = "SCOOTER_ROUTER_TOKEN_PATH"; value = "/var/run/secrets/scooter-router/token"; }

                  # Every broker store resolves its DSN from these, and a store that
                  # finds no password silently falls back to a SQLite dev path.
                  { name = "BROKER_DB_HOST"; value = cfg.postgres.host; }
                  { name = "BROKER_DB_PORT"; value = toString cfg.postgres.port; }
                  { name = "BROKER_DB_NAME"; value = "broker"; }
                  { name = "BROKER_DB_USER"; value = "broker"; }
                  { name = "BROKER_DB_PASSWORD"; valueFrom.secretKeyRef = { name = "agent-pg-broker"; key = "password"; }; }

                  # The agent-host relays a user's action as itself, so core auth
                  # admits it as a non-sandbox caller and sets is_approver.
                  { name = "APPROVER_SERVICE_ACCOUNTS"; value = "system:serviceaccount:${cfg.namespace}:agent-host"; }
                  # The agent-host's /contrib-api relay names the signed-in user in
                  # X-Scooter-User; the broker trusts that header from this account only.
                  { name = "USER_RELAY_SERVICE_ACCOUNTS"; value = "system:serviceaccount:${cfg.namespace}:agent-host"; }
                  # System tasks run in the scheduler pod and call contribs' /system routes as it.
                  { name = "SYSTEM_TASK_SERVICE_ACCOUNTS"; value = lib.optionalString cfg.scheduler.enable "system:serviceaccount:${cfg.namespace}:agent-scheduler"; }

                  # --- The agent-facing MCP endpoint ---------------------------------
                  # Who may act for a conversation by presenting a signed conversation
                  # token, a separate grant from APPROVER_SERVICE_ACCOUNTS.
                  { name = "MCP_CALLER_SERVICE_ACCOUNTS"; value = "system:serviceaccount:${cfg.namespace}:agent-host"; }
                  # The HS256 key, from the same Secret the agent-host signs with.
                  {
                    name = "CONV_TOKEN_SECRET";
                    valueFrom.secretKeyRef = { name = cfg.convTokenSecret; key = "secret"; };
                  }
                  # Whether the broker serves its own tool surface.
                  { name = "MCP_ENABLED"; value = lib.boolToString bcfg.mcp.enable; }
                ] ++ lib.optional (cfg.postgres.sslmode != null)
                  { name = "BROKER_DB_SSLMODE"; value = cfg.postgres.sslmode; }
                ++ [
                  { name = "FORGE_PROXY_PORT"; value = toString bcfg.forgeProxy.port; }
                ] ++ lib.optionals bcfg.fga.enable [
                  # Settings for the authorizer core/authz.py hands to every provider.
                  { name = "FGA_ENABLED"; value = "true"; }
                  { name = "FGA_API_URL"; value = bcfg.fga.apiUrl; }
                  { name = "FGA_STORE_ID"; value = bcfg.fga.storeId; }
                  { name = "FGA_AUTHORIZATION_MODEL_ID"; value = bcfg.fga.authorizationModelId; }
                ]
                # k8s silently keeps the last of a duplicated env name, so
                # examples/check.nix asserts this container has none.
                ++ cfg.contribDbEnv.broker ++ bcfg.extraEnv;
                volumeMounts = [
                  { name = "scooter-router-token"; mountPath = "/var/run/secrets/scooter-router"; readOnly = true; }
                ] ++ bcfg.extraVolumeMounts;
                readinessProbe.httpGet = { path = "/health"; port = "http"; };
                livenessProbe.httpGet = { path = "/health"; port = "http"; };
              };
              volumes = [{
                name = "scooter-router-token";
                projected.sources = [{ serviceAccountToken = { audience = "scooter-router"; path = "token"; expirationSeconds = 3600; }; }];
              }] ++ bcfg.extraVolumes;
            };
          };
        };
      };

      services.agent-broker = {
        metadata = { name = "agent-broker"; namespace = cfg.namespace; };
        spec = {
          selector.app = "agent-broker";
          ports = [
            { port = 8080; targetPort = "http"; name = "http"; }
            { port = bcfg.forgeProxy.port; targetPort = "forge-proxy"; name = "forge-proxy"; }
          ];
        };
      };
    }
    {
      # The forge CA: the broker creates the Secret (key) and ConfigMap (public cert +
      # hosts) on first start. `create` cannot be narrowed by resourceNames.
      roles.agent-broker-forge-ca = {
        metadata = { name = "agent-broker-forge-ca"; namespace = cfg.namespace; };
        rules = [
          { apiGroups = [ "" ]; resources = [ "secrets" "configmaps" ]; verbs = [ "create" ]; }
          {
            apiGroups = [ "" ];
            resources = [ "secrets" "configmaps" ];
            resourceNames = [ "scooter-forge-ca" ];
            verbs = [ "get" "update" ];
          }
        ];
      };
      roleBindings.agent-broker-forge-ca = {
        metadata = { name = "agent-broker-forge-ca"; namespace = cfg.namespace; };
        roleRef = { apiGroup = "rbac.authorization.k8s.io"; kind = "Role"; name = "agent-broker-forge-ca"; };
        subjects = [{ kind = "ServiceAccount"; name = "agent-broker"; namespace = cfg.namespace; }];
      };

      # The keyring sealing per-user secrets, created on first use; never mounted anywhere.
      roles.agent-broker-user-secrets = {
        metadata = { name = "agent-broker-user-secrets"; namespace = cfg.namespace; };
        rules = [
          { apiGroups = [ "" ]; resources = [ "secrets" ]; verbs = [ "create" ]; }
          {
            apiGroups = [ "" ];
            resources = [ "secrets" ];
            resourceNames = [ "scooter-user-secrets-key" ];
            verbs = [ "get" ];
          }
        ];
      };
      roleBindings.agent-broker-user-secrets = {
        metadata = { name = "agent-broker-user-secrets"; namespace = cfg.namespace; };
        roleRef = { apiGroup = "rbac.authorization.k8s.io"; kind = "Role"; name = "agent-broker-user-secrets"; };
        subjects = [{ kind = "ServiceAccount"; name = "agent-broker"; namespace = cfg.namespace; }];
      };
    }
    (lib.mkIf bcfg.fga.enable {
      # OpenFGA server backed by its own `openfga` database in the shared Postgres;
      # the broker seeds the model and approver tuples at startup.
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
                  # OpenFGA's own db and auto-provisioned role in the shared Postgres.
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

    # The sandbox half: the CA/hosts ConfigMap (optional, so pods start before the
    # broker first publishes it) and the env that points HTTPS clients at the in-pod
    # shim (modules/sandbox-os/forge-proxy.nix). The bundle paths exist from boot:
    # activation appends the forge CA to the system bundle before systemd starts.
    scooter.sandboxPod = {
      extraVolumes = [
        { name = "forge-ca"; configMap = { name = "scooter-forge-ca"; optional = true; }; }
      ];
      extraVolumeMounts = [
        { name = "forge-ca"; mountPath = "/etc/scooter/forge-ca"; readOnly = true; }
      ];
      extraEnv =
        let
          bundle = "/etc/ssl/certs/ca-certificates.crt";
          proxy = "http://127.0.0.1:3128";
          noProxy = "localhost,127.0.0.1,::1,.svc,.cluster.local";
        in [
          { name = "FORGE_PROXY_ADDR"; value = "agent-broker.${cfg.namespace}.svc.cluster.local:${toString bcfg.forgeProxy.port}"; }
          { name = "HTTPS_PROXY"; value = proxy; }
          { name = "https_proxy"; value = proxy; }
          { name = "NO_PROXY"; value = noProxy; }
          { name = "no_proxy"; value = noProxy; }
          { name = "SSL_CERT_FILE"; value = bundle; }
          { name = "GIT_SSL_CAINFO"; value = bundle; }
          { name = "CURL_CA_BUNDLE"; value = bundle; }
          { name = "REQUESTS_CA_BUNDLE"; value = bundle; }
          { name = "NODE_EXTRA_CA_CERTS"; value = "/etc/scooter/forge-ca/ca.crt"; }
        ];
    };

    # The provisioning Job creates each db and its owner role from these.
    scooter.postgres.consumers = lib.mkMerge [
      { broker = { db = "broker"; user = "broker"; }; }
      (lib.mkIf bcfg.fga.enable { openfga = { db = "openfga"; user = "openfga"; }; })
    ];
  })
  ];
}
