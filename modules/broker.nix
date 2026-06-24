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
  };

  config = lib.mkIf bcfg.enable {
    kubernetes.resources = {
      serviceAccounts.agent-broker = {
        metadata = { name = "agent-broker"; namespace = cfg.namespace; };
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
                ];
                readinessProbe.httpGet = { path = "/health"; port = "http"; };
                livenessProbe.httpGet = { path = "/health"; port = "http"; };
              };
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
    };
  };
}
