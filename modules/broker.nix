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
      accounts = mkOption {
        type = types.attrsOf (types.attrsOf types.anything);
        default = { };
        description = ''
          The account registry: alias -> { account_id, broker_role_arn, enabled,
          allowed_policy?, allowed_managed_policies?, region? }. Rendered into a
          ConfigMap mounted at /etc/agent-broker/accounts.json.
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
          description = "Secret + key for the Postgres password (shared agent-webhooks-db). null = SQLite (dev).";
        };
        host = mkOption { type = types.str; default = "agent-webhooks-db.${cfg.namespace}.svc.cluster.local"; description = "Postgres host."; };
        name = mkOption { type = types.str; default = "broker"; description = "Database name (separate DB on the shared instance)."; };
        user = mkOption { type = types.str; default = "webhooks"; description = "Database user."; };
      };
    };
  };

  config = lib.mkIf bcfg.enable {
    kubernetes.resources = {
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
            metadata.labels.app = "agent-broker";
            spec = {
              serviceAccountName = "agent-broker";
              containers.agent-broker = {
                name = "agent-broker";
                image = bcfg.image;
                imagePullPolicy = cfg.pullPolicy;
                command = [ "agent-broker" ];
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
                ] ++ lib.optionals bcfg.aws.enable ([
                  { name = "AWS_ENABLED"; value = "true"; }
                  { name = "AWS_REGION"; value = bcfg.aws.region; }
                  { name = "AWS_STS_EXTERNAL_ID"; value = bcfg.aws.externalId; }
                  { name = "AWS_BROKER_PRINCIPAL_ARN"; value = bcfg.aws.brokerPrincipalArn; }
                  { name = "AWS_ACCOUNTS_FILE"; value = "/etc/agent-broker/accounts.json"; }
                  { name = "AWS_ROLE_TTL_HOURS"; value = toString bcfg.aws.roleTtlHours; }
                  { name = "AWS_AGENT_HOST_URL"; value = bcfg.aws.agentHostUrl; }
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
    } // lib.optionalAttrs bcfg.aws.enable {
      # The account registry, mounted at /etc/agent-broker/accounts.json. Single
      # source of truth shared with the sandbox's ~/.aws/config profiles.
      configMaps.agent-broker-aws-accounts = {
        metadata = { name = "agent-broker-aws-accounts"; namespace = cfg.namespace; };
        data."accounts.json" = builtins.toJSON bcfg.aws.accounts;
      };
    };
  };
}
