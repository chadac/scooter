# Webhooks — Deployment + Service + (optional) Ingress.
#
# Receives provider webhooks (GitHub/GitLab/Jira/Slack) and spawns agent
# conversations via the agent-host /agui. Must be publicly reachable for
# providers to call it → a Traefik ingress (gated; in-cluster tests don't need
# it). Providers authenticate by SIGNATURE (HMAC), so the ingress is
# deliberately UNAUTHENTICATED — do NOT attach a basic-auth middleware or
# GitHub/Slack deliveries would be rejected before signature checks run.
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
      default = "${cfg.registryPrefix}agent-webhooks:latest";
      defaultText = literalExpression ''"''${registryPrefix}agent-webhooks:latest"'';
      description = "OCI ref of the webhooks image.";
    };
    testWebhook = mkOption {
      type = types.bool;
      default = false;
      description = "Enable /webhooks/test for the spawn-from-webhook e2e.";
    };

    # --- Provider enablement ------------------------------------------------
    githubEnabled = mkOption {
      type = types.bool;
      default = false;
      description = "Enable the GitHub webhook handler (/webhooks/github).";
    };
    gitlabEnabled = mkOption {
      type = types.bool;
      default = false;
      description = "Enable the GitLab webhook handler (/webhooks/gitlab).";
    };
    slackEnabled = mkOption {
      type = types.bool;
      default = false;
      description = "Enable the Slack events handler (/webhooks/slack).";
    };

    # --- Trigger convention -------------------------------------------------
    mentionPattern = mkOption {
      type = types.str;
      default = "@agent";
      description = ''
        Text the agent looks for to treat a comment/message as a request.
        GitHub @<name> does not autocomplete for non-users, so a sigil like
        "!scooter" reads better there; Slack uses its native app_mention event
        regardless of this string.
      '';
    };
    labelTrigger = mkOption {
      type = types.str;
      default = "scooter";
      description = "Issue/PR label name that triggers a conversation (GitHub/GitLab).";
    };

    # --- Provider secrets ---------------------------------------------------
    # A Secret supplying GITHUB_WEBHOOK_SECRET / SLACK_SIGNING_SECRET /
    # SLACK_BOT_TOKEN (+ optionally GITHUB_TOKEN). envFrom-mounted, so the keys
    # must match those env var names (case-insensitive). Empty = none mounted.
    secretName = mkOption {
      type = types.str;
      default = "";
      description = "Name of a Secret (same namespace) envFrom-mounted for provider creds.";
    };

    ingress = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = "Create a Traefik ingress (webhooks must be publicly reachable).";
      };
      host = mkOption {
        type = types.str;
        default = "";
        description = "Ingress host (e.g. scooter.example.com).";
      };
      entryPoint = mkOption {
        type = types.str;
        default = "websecure";
        description = "Traefik entryPoint (websecure = auto-TLS via the cert resolver).";
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
                imagePullPolicy = cfg.pullPolicy;
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
                  { name = "GITHUB_ENABLED"; value = lib.boolToString wcfg.githubEnabled; }
                  { name = "GITLAB_ENABLED"; value = lib.boolToString wcfg.gitlabEnabled; }
                  { name = "SLACK_ENABLED"; value = lib.boolToString wcfg.slackEnabled; }
                  { name = "MENTION_PATTERN"; value = wcfg.mentionPattern; }
                  { name = "LABEL_TRIGGER"; value = wcfg.labelTrigger; }
                ];
                # Provider signing secrets / tokens come from a Secret whose keys
                # match the GITHUB_WEBHOOK_SECRET / SLACK_* env var names.
                envFrom = lib.optionals (wcfg.secretName != "") [
                  { secretRef.name = wcfg.secretName; }
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
      # DNS-only companion Ingress: external-dns runs --source=ingress (NOT the
      # Traefik IngressRoute CRD), so the standard Ingress is what registers the
      # hostname in Route53. The IngressRoute below does the actual routing+TLS.
      # (Mirrors the agent-host / openhands env-manager-dns pattern.)
      ingresses.agent-webhooks-dns = {
        metadata = {
          name = "agent-webhooks-dns";
          namespace = cfg.namespace;
          annotations."external-dns.alpha.kubernetes.io/hostname" = wcfg.ingress.host;
        };
        spec = {
          ingressClassName = "traefik";
          rules = [{
            host = wcfg.ingress.host;
            http.paths = [{
              path = "/webhooks";
              pathType = "Prefix";
              backend.service = { name = "agent-webhooks"; port.number = 8080; };
            }];
          }];
        };
      };
    };

    # Public ingress (opt-in). Traefik IngressRoute is a CRD → kubernetes.objects.
    # NO middlewares: providers sign their requests, so this route is
    # intentionally open (unlike the basic-auth-gated agent-host UI route).
    kubernetes.objects = lib.optionals (wcfg.ingress.enable) [
      {
        apiVersion = "traefik.io/v1alpha1";
        kind = "IngressRoute";
        metadata = {
          name = "agent-webhooks";
          namespace = cfg.namespace;
          annotations."external-dns.alpha.kubernetes.io/hostname" = wcfg.ingress.host;
        };
        spec = {
          entryPoints = [ wcfg.ingress.entryPoint ];
          routes = [{
            kind = "Rule";
            match = "Host(`${wcfg.ingress.host}`) && PathPrefix(`/webhooks`)";
            services = [{ name = "agent-webhooks"; port = 8080; }];
          }];
        };
      }
    ];
  };
}
