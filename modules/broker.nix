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

    # --- GitLab (static token; http-proxy to gitlab.com/api/v4) --------------
    # The broker's gitlab provider proxies /gitlab/* -> https://gitlab.com/api/v4
    # with the token injected (PRIVATE-TOKEN header), so the agent can comment on
    # MRs / create notes WITHOUT seeing the token. Enabled iff GITLAB_TOKEN is set
    # on the broker — hence this option (without it the /gitlab/* routes never
    # mount and the agent's calls 404).
    gitlab = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = "Enable the GitLab provider (http-proxy to gitlab.com/api/v4 with the token injected).";
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

    # --- AWS permissions broker (dynamic, approval-gated AWS access) --------
    aws = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = "Enable the AWS permissions provider (request/approve/provision dynamic IAM roles).";
      };
      region = mkOption { type = types.str; default = "us-east-1"; description = "AWS region."; };
      externalId = mkOption {
        type = types.str;
        default = "agent-permissions-broker";
        description = "STS ExternalId used when the broker assumes each account's base role.";
      };
      brokerPrincipalArn = mkOption {
        type = types.str;
        default = "";
        description = "The broker's IRSA role ARN — the principal the dynamic roles trust.";
      };
      serviceAccountRoleArn = mkOption {
        type = types.str;
        default = "";
        description = "IRSA role ARN annotated on the broker SA (eks.amazonaws.com/role-arn). Usually == brokerPrincipalArn.";
      };
      roleTtlHours = mkOption { type = types.int; default = 12; description = "Dynamic-role TTL (refresh window)."; };
      approverClaim = mkOption {
        type = types.enum [ "email" "id" "name" ];
        default = "email";
        description = ''
          Which identity claim authorizes an approver — must match how the FGA
          `approver` tuples are seeded (accounts.<a>.approvers, conventionally
          emails). The agent-host sends the answering user's {id, email, name}; the
          broker checks THIS claim. "email" (default) suits ALB-OIDC (where the id
          is an opaque sub); use "id" for header-auth that already carries emails.
        '';
      };
      accounts = mkOption {
        type = types.attrsOf (types.attrsOf types.anything);
        default = { };
        description = ''
          The account registry: alias -> { account_id, broker_role_arn, enabled,
          description?, allowed_policy?, allowed_managed_policies?, region?,
          approvers?, auto_approve_read_only? }. Rendered into a ConfigMap mounted
          at /etc/agent-broker/accounts.json.

          `description` is a human-written summary of what the account is for. The
          agent reads it (via `scooter-aws accounts` → GET /aws/accounts) to pick
          the RIGHT account to request access to — set it on every account.

          Set `auto_approve_read_only = true` on an account to grant purely
          read-only requests (all actions Get*/List*/Describe*/… ; no managed-policy
          ARNs) immediately, WITHOUT a human approver — recorded as approved_by
          "system:auto-approve-read-only". Anything with a write action or a managed
          ARN still needs a human. Default off (every request needs approval).
          Example:
            accounts.readonly-sandbox = {
              account_id = "123456789012";
              broker_role_arn = "arn:aws:iam::123456789012:role/agent-token-broker-base";
              enabled = true;
              description = "Sandbox account for safe read-only exploration (S3, logs).";
              auto_approve_read_only = true;
            };
        '';
      };
      agentHostUrl = mkOption {
        type = types.str;
        default = "http://agent-host.${cfg.namespace}.svc.cluster.local:8080";
        description = "Agent-host URL — the broker notifies it to raise the approval interrupt.";
      };
      db = {
        passwordSecret = mkOption {
          type = types.nullOr (types.submodule {
            options = {
              name = mkOption { type = types.str; description = "Secret name."; };
              key = mkOption { type = types.str; default = "password"; description = "Key holding the DB password."; };
            };
          });
          default = null;
          description = "Secret + key for the Postgres password (shared agent-shared-db). null = SQLite (dev).";
        };
        host = mkOption { type = types.str; default = "agent-shared-db.${cfg.namespace}.svc.cluster.local"; description = "Postgres host (shared instance)."; };
        name = mkOption { type = types.str; default = "broker"; description = "Database name (separate DB on the shared instance)."; };
        user = mkOption { type = types.str; default = "webhooks"; description = "Database user."; };
      };
      # OpenFGA authorization: the broker ENFORCES which user may approve which
      # account (relation `approver` on `aws_account:<alias>`). Off by default →
      # the broker's NoopAuthorizer → today's behavior. Per-account approver lists
      # live in `accounts.<alias>.approvers` (seeded into OpenFGA at startup).
      fga = {
        enable = mkOption {
          type = types.bool;
          default = false;
          description = "Enforce per-account approver authorization via OpenFGA. Deploys an openfga server.";
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
  };

  config = lib.mkIf bcfg.enable {
    # mkMerge (not //): the aws + fga blocks each add to `deployments`/`services`,
    # and a shallow // would REPLACE those keys (dropping agent-broker). mkMerge
    # deep-merges so all deployments/services coexist.
    kubernetes.resources = lib.mkMerge [
    {
      serviceAccounts.agent-broker = {
        metadata = {
          name = "agent-broker";
          namespace = cfg.namespace;
        } // lib.optionalAttrs (bcfg.aws.enable && bcfg.aws.serviceAccountRoleArn != "") {
          # IRSA: the broker pod assumes the per-account base roles via this role.
          annotations."eks.amazonaws.com/role-arn" = bcfg.aws.serviceAccountRoleArn;
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
          replicas = 1;
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
              # (Standard k8s pattern; Helm does this with sha256sum.) Only the
              # aws-accounts CM exists today; add more checksum/* as needed.
              annotations = lib.optionalAttrs bcfg.aws.enable {
                "checksum/aws-accounts" =
                  builtins.hashString "sha256" (builtins.toJSON bcfg.aws.accounts);
              };
            };
            spec = {
              serviceAccountName = "agent-broker";
              containers.agent-broker = {
                name = "agent-broker";
                image = bcfg.image;
                imagePullPolicy = cfg.pullPolicy;
                command = [ "agent-broker" ];
                # A lightweight credential-vending service.
                resources = lib.mkDefault {
                  requests = { cpu = "50m"; memory = "128Mi"; };
                  limits = { memory = "512Mi"; };
                };
                ports = [{ containerPort = 8080; name = "http"; }];
                env = [
                  { name = "PORT"; value = "8080"; }
                  { name = "TOKEN_AUDIENCE"; value = "agent-broker"; }
                  { name = "SANDBOX_NAMESPACE"; value = cfg.namespace; }
                  { name = "TEST_PROVIDER_ENABLED"; value = lib.boolToString bcfg.testProvider; }
                ] ++ lib.optionals bcfg.githubApp.enable [
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
                  # to gitlab.com/api/v4 with this injected. Without it the provider
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
                ] ++ lib.optionals bcfg.aws.enable ([
                  { name = "AWS_ENABLED"; value = "true"; }
                  { name = "AWS_REGION"; value = bcfg.aws.region; }
                  { name = "AWS_STS_EXTERNAL_ID"; value = bcfg.aws.externalId; }
                  { name = "AWS_BROKER_PRINCIPAL_ARN"; value = bcfg.aws.brokerPrincipalArn; }
                  { name = "AWS_ACCOUNTS_FILE"; value = "/etc/agent-broker/accounts.json"; }
                  { name = "AWS_ROLE_TTL_HOURS"; value = toString bcfg.aws.roleTtlHours; }
                  { name = "AWS_APPROVER_CLAIM"; value = bcfg.aws.approverClaim; }
                  { name = "AWS_AGENT_HOST_URL"; value = bcfg.aws.agentHostUrl; }
                  # The agent-host SA may approve/deny (it relays the user's pick).
                  { name = "AWS_APPROVER_SERVICE_ACCOUNTS"; value = "system:serviceaccount:${cfg.namespace}:agent-host"; }
                  { name = "AWS_DB_HOST"; value = bcfg.aws.db.host; }
                  { name = "AWS_DB_NAME"; value = bcfg.aws.db.name; }
                  { name = "AWS_DB_USER"; value = bcfg.aws.db.user; }
                ] ++ lib.optionals (bcfg.aws.db.passwordSecret != null) [
                  {
                    name = "AWS_DB_PASSWORD";
                    valueFrom.secretKeyRef = {
                      inherit (bcfg.aws.db.passwordSecret) name key;
                    };
                  }
                ] ++ lib.optionals bcfg.aws.fga.enable [
                  # OpenFGA authorization (the per-account approver gate).
                  { name = "FGA_ENABLED"; value = "true"; }
                  { name = "FGA_API_URL"; value = bcfg.aws.fga.apiUrl; }
                  { name = "FGA_STORE_ID"; value = bcfg.aws.fga.storeId; }
                  { name = "FGA_AUTHORIZATION_MODEL_ID"; value = bcfg.aws.fga.authorizationModelId; }
                ]);
                volumeMounts = lib.optionals bcfg.aws.enable [
                  { name = "aws-accounts"; mountPath = "/etc/agent-broker"; readOnly = true; }
                ];
                readinessProbe.httpGet = { path = "/health"; port = "http"; };
                livenessProbe.httpGet = { path = "/health"; port = "http"; };
              };
              volumes = lib.optionals bcfg.aws.enable [
                { name = "aws-accounts"; configMap.name = "agent-broker-aws-accounts"; }
              ];
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
    (lib.mkIf bcfg.aws.enable {
      # The account registry, mounted at /etc/agent-broker/accounts.json. Single
      # source of truth shared with the sandbox's ~/.aws/config profiles. Each
      # account's optional `approvers` list (user ids) is seeded into OpenFGA by
      # the broker at startup when fga.enable is set.
      configMaps.agent-broker-aws-accounts = {
        metadata = { name = "agent-broker-aws-accounts"; namespace = cfg.namespace; };
        data."accounts.json" = builtins.toJSON bcfg.aws.accounts;
      };
    })
    (lib.mkIf bcfg.aws.fga.enable {
      # OpenFGA authorization server — the broker's policy enforcement backend.
      # Uses the shared Postgres (agent-shared-db) as its datastore (a separate
      # `openfga` database). The broker seeds the model + approver tuples at
      # startup. (storeId/modelId are provided via broker.aws.fga options once
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
              image = bcfg.aws.fga.image;
              args = [ "run" ];
              env = [
                { name = "OPENFGA_DATASTORE_ENGINE"; value = "postgres"; }
                {
                  # postgres://user:pass@host:5432/openfga
                  name = "OPENFGA_DATASTORE_URI";
                  value = "postgres://${bcfg.aws.db.user}@${bcfg.aws.db.host}:5432/openfga?sslmode=disable";
                }
              ] ++ lib.optionals (bcfg.aws.db.passwordSecret != null) [
                {
                  name = "OPENFGA_DATASTORE_PASSWORD";
                  valueFrom.secretKeyRef = { inherit (bcfg.aws.db.passwordSecret) name key; };
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
  };
}
