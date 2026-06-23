# Platform manifests — the long-lived deployment of kubenix-agent-manager.
#
# Renders: namespace, the agent-host Deployment + Service, and the RBAC the
# agent-host needs to (a) provision per-conversation Sandboxes/SAs/PVCs and
# (b) exec into sandbox pods.
#
# The agent-sandbox controller + CRDs are installed separately (upstream release
# manifests); this module only deploys OUR platform on top.
#
# Per-conversation Sandboxes are created at runtime by the agent-host via the
# kube API (not here) — see modules/conversation.nix for that shape.

{ kubenix, config, lib, ... }:

let
  cfg = config.agentSandbox;
in
{
  imports = [ kubenix.modules.k8s ./broker.nix ];

  options.agentSandbox = with lib; {
    namespace = mkOption {
      type = types.str;
      default = "agent-sandbox";
      description = "Namespace for the platform + sandboxes.";
    };
    agentHostImage = mkOption {
      type = types.str;
      default = "agent-host:latest";
      description = "OCI ref of the agent-host image.";
    };
    sandboxImage = mkOption {
      type = types.str;
      default = "agent-sandbox-nix:latest";
      description = "OCI ref of the generic Nix sandbox image.";
    };
    replicas = mkOption {
      type = types.int;
      default = 1;
      description = "agent-host replicas (one host pod runs many goose sessions).";
    };
  };

  config = {
    kubernetes.resources = {
      namespaces.${cfg.namespace} = {
        metadata.name = cfg.namespace;
      };

      serviceAccounts.agent-host = {
        metadata = { name = "agent-host"; namespace = cfg.namespace; };
      };

      # The agent-host provisions per-conversation Sandboxes/SAs/PVCs and execs
      # into sandbox pods, so it needs broad-but-namespaced RBAC.
      roles.agent-host = {
        metadata = { name = "agent-host"; namespace = cfg.namespace; };
        rules = [
          {
            apiGroups = [ "agents.x-k8s.io" ];
            resources = [ "sandboxes" ];
            verbs = [ "get" "list" "watch" "create" "update" "patch" "delete" ];
          }
          {
            apiGroups = [ "" ];
            resources = [ "serviceaccounts" "persistentvolumeclaims" "pods" ];
            verbs = [ "get" "list" "watch" "create" "update" "patch" "delete" ];
          }
          {
            # Exec is how the ExecBackend runs the agent's commands in the pod.
            apiGroups = [ "" ];
            resources = [ "pods/exec" ];
            verbs = [ "create" ];
          }
        ];
      };

      roleBindings.agent-host = {
        metadata = { name = "agent-host"; namespace = cfg.namespace; };
        roleRef = { apiGroup = "rbac.authorization.k8s.io"; kind = "Role"; name = "agent-host"; };
        subjects = [{ kind = "ServiceAccount"; name = "agent-host"; namespace = cfg.namespace; }];
      };

      deployments.agent-host = {
        metadata = { name = "agent-host"; namespace = cfg.namespace; };
        spec = {
          replicas = cfg.replicas;
          selector.matchLabels.app = "agent-host";
          template = {
            metadata.labels.app = "agent-host";
            spec = {
              serviceAccountName = "agent-host";
              containers.agent-host = {
                name = "agent-host";
                image = cfg.agentHostImage;
                imagePullPolicy = "IfNotPresent";
                ports = [{ containerPort = 8080; name = "agui"; }];
                env = [
                  { name = "PORT"; value = "8080"; }
                  { name = "NAMESPACE"; value = cfg.namespace; }
                  { name = "SANDBOX_IMAGE"; value = cfg.sandboxImage; }
                  { name = "STATE_PATH"; value = "/var/lib/agent-host/conversations"; }
                ];
                volumeMounts = [{ name = "state"; mountPath = "/var/lib/agent-host"; }];
                readinessProbe.httpGet = { path = "/healthz"; port = "agui"; };
              };
              # Conversation-state PVC (Goose state + AG-UI event logs).
              volumes = [{ name = "state"; persistentVolumeClaim.claimName = "agent-host-state"; }];
            };
          };
        };
      };

      persistentVolumeClaims.agent-host-state = {
        metadata = { name = "agent-host-state"; namespace = cfg.namespace; };
        spec = {
          accessModes = [ "ReadWriteOnce" ];
          resources.requests.storage = "5Gi";
        };
      };

      services.agent-host = {
        metadata = { name = "agent-host"; namespace = cfg.namespace; };
        spec = {
          selector.app = "agent-host";
          ports = [{ port = 8080; targetPort = "agui"; name = "agui"; }];
        };
      };
    };
  };
}
