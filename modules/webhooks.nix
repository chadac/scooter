# Webhooks — Deployment + Service + (optional) Ingress.
#
# Receives provider webhooks (GitHub/GitLab/Jira/Slack) and spawns agent
# conversations via the agent-host /agui. Must be publicly reachable for
# providers to call it → an Ingress (gated; in-cluster tests don't need it).
# See docs/WEBHOOKS.md + services/webhooks/.

{ config, lib, ... }:

let
  cfg = config.agentSandbox;
  wcfg = cfg.webhooks;
in
{
  options.agentSandbox.webhooks = with lib; {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "Deploy the webhooks service.";
    };
    image = mkOption {
      type = types.str;
      default = "agent-webhooks:latest";
      description = "OCI ref of the webhooks image.";
    };
    testWebhook = mkOption {
      type = types.bool;
      default = false;
      description = "Enable /webhooks/test for the spawn-from-webhook e2e.";
    };
    ingress = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = "Create an Ingress (webhooks must be publicly reachable).";
      };
      host = mkOption {
        type = types.str;
        default = "";
        description = "Ingress host (e.g. webhooks.example.com).";
      };
      className = mkOption {
        type = types.str;
        default = "nginx";
        description = "IngressClass name.";
      };
    };
  };

  config = lib.mkIf wcfg.enable {
    kubernetes.resources = {
      serviceAccounts.agent-webhooks = {
        metadata = { name = "agent-webhooks"; namespace = cfg.namespace; };
      };

      deployments.agent-webhooks = {
        metadata = { name = "agent-webhooks"; namespace = cfg.namespace; };
        spec = {
          replicas = 1;
          selector.matchLabels.app = "agent-webhooks";
          template = {
            metadata.labels.app = "agent-webhooks";
            spec = {
              serviceAccountName = "agent-webhooks";
              containers.agent-webhooks = {
                name = "agent-webhooks";
                image = wcfg.image;
                imagePullPolicy = "IfNotPresent";
                command = [ "agent-webhooks" ];
                ports = [{ containerPort = 8080; name = "http"; }];
                env = [
                  { name = "PORT"; value = "8080"; }
                  {
                    name = "AGENT_HOST_URL";
                    value = "http://agent-host.${cfg.namespace}.svc.cluster.local:8080";
                  }
                  # SQLite store under an emptyDir (single replica). Postgres DSN
                  # via DSN env for multi-replica.
                  { name = "DSN"; value = "sqlite+aiosqlite:////data/webhooks.db"; }
                  { name = "TEST_WEBHOOK_ENABLED"; value = lib.boolToString wcfg.testWebhook; }
                  # Provider secrets come from a Secret in production (omitted;
                  # providers stay disabled without their config).
                ];
                volumeMounts = [{ name = "data"; mountPath = "/data"; }];
                readinessProbe.httpGet = { path = "/health"; port = "http"; };
                livenessProbe.httpGet = { path = "/health"; port = "http"; };
              };
              volumes = [{ name = "data"; emptyDir = { }; }];
            };
          };
        };
      };

      services.agent-webhooks = {
        metadata = { name = "agent-webhooks"; namespace = cfg.namespace; };
        spec = {
          selector.app = "agent-webhooks";
          ports = [{ port = 8080; targetPort = "http"; name = "http"; }];
        };
      };
    } // lib.optionalAttrs wcfg.ingress.enable {
      ingresses.agent-webhooks = {
        metadata = {
          name = "agent-webhooks";
          namespace = cfg.namespace;
        };
        spec = {
          ingressClassName = wcfg.ingress.className;
          rules = [{
            host = wcfg.ingress.host;
            http.paths = [{
              path = "/webhooks";
              pathType = "Prefix";
              backend.service = {
                name = "agent-webhooks";
                port.number = 8080;
              };
            }];
          }];
        };
      };
    };
  };
}
