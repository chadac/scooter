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

    # --- Durable mapping store (Postgres) ----------------------------------
    # The PR/Slack <-> conversation mapping (ConversationMap) MUST survive a pod
    # restart, or follow-up comments spawn a new conversation instead of resuming
    # and status-back-posting stops. Default SQLite-on-emptyDir is ephemeral;
    # enable this to run a Postgres pod (PVC-backed) and point DSN at it.
    postgres = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = "Run a Postgres pod (PVC-backed) for the durable mapping store.";
      };
      image = mkOption {
        type = types.str;
        default = "postgres:16-alpine";
        description = "Postgres image.";
      };
      database = mkOption {
        type = types.str;
        default = "webhooks";
        description = "Database name.";
      };
      user = mkOption {
        type = types.str;
        default = "webhooks";
        description = "Database user.";
      };
      passwordSecret = mkOption {
        type = types.submodule {
          options = {
            name = mkOption { type = types.str; description = "Secret name."; };
            key = mkOption { type = types.str; default = "password"; description = "Key holding the password."; };
          };
        };
        description = "Secret + key supplying the Postgres password (shared by the DB and the app DSN).";
      };
      storage = mkOption {
        type = types.str;
        default = "1Gi";
        description = "PVC size for the Postgres data volume.";
      };
      storageClass = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "PVC storageClassName (null = cluster default).";
      };
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
    # mkMerge (NOT `//`): the postgres block reuses the `deployments`/`services`
    # keys, and a shallow `//` would CLOBBER the app's deployment/service with the
    # DB's. mkMerge deep-merges so both survive.
    kubernetes.resources = lib.mkMerge [
    {
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
                  { name = "TEST_WEBHOOK_ENABLED"; value = lib.boolToString wcfg.testWebhook; }
                  { name = "GITHUB_ENABLED"; value = lib.boolToString wcfg.githubEnabled; }
                  { name = "GITLAB_ENABLED"; value = lib.boolToString wcfg.gitlabEnabled; }
                  { name = "SLACK_ENABLED"; value = lib.boolToString wcfg.slackEnabled; }
                  { name = "MENTION_PATTERN"; value = wcfg.mentionPattern; }
                  { name = "LABEL_TRIGGER"; value = wcfg.labelTrigger; }
                ] ++ (if wcfg.postgres.enable then [
                  # Durable Postgres store. The DSN is assembled app-side from
                  # these components so the password comes from a secretKeyRef
                  # (never a full connection string in the manifest).
                  { name = "DB_HOST"; value = "agent-shared-db.${cfg.namespace}.svc.cluster.local"; }
                  { name = "DB_PORT"; value = "5432"; }
                  { name = "DB_NAME"; value = wcfg.postgres.database; }
                  { name = "DB_USER"; value = wcfg.postgres.user; }
                  {
                    name = "DB_PASSWORD";
                    valueFrom.secretKeyRef = {
                      inherit (wcfg.postgres.passwordSecret) name key;
                    };
                  }
                ] else [
                  # Ephemeral SQLite on the emptyDir (dev / single-pod, lost on
                  # restart). Enable postgres for durability.
                  { name = "DSN"; value = "sqlite+aiosqlite:////data/webhooks.db"; }
                ]);
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
    }
    (lib.mkIf wcfg.postgres.enable {
      # Shared durable Postgres for the platform — a single-replica instance
      # backed by a PVC. It hosts MULTIPLE logical databases (the webhooks
      # PR/Slack <-> conversation mappings here, plus the AWS broker's `broker`
      # DB), so the name is deliberately neutral (`agent-shared-db`, not
      # webhooks-specific). The webhooks app provisions this pod; the broker
      # connects to the same Service. The app reads DB_PASSWORD from the same
      # secret used here.
      persistentVolumeClaims.agent-shared-db = {
        metadata = { name = "agent-shared-db"; namespace = cfg.namespace; };
        spec = {
          accessModes = [ "ReadWriteOnce" ];
          resources.requests.storage = wcfg.postgres.storage;
        } // lib.optionalAttrs (wcfg.postgres.storageClass != null) {
          storageClassName = wcfg.postgres.storageClass;
        };
      };

      deployments.agent-shared-db = {
        metadata = { name = "agent-shared-db"; namespace = cfg.namespace; };
        spec = {
          replicas = 1;
          # Recreate (not RollingUpdate): a single RWO PVC can't be mounted by
          # two pods, so the old pod must fully release it before the new one.
          strategy.type = "Recreate";
          selector.matchLabels.app = "agent-shared-db";
          template = {
            metadata.labels.app = "agent-shared-db";
            spec = {
              containers.postgres = {
                name = "postgres";
                image = wcfg.postgres.image;
                ports = [{ containerPort = 5432; name = "pg"; }];
                env = [
                  { name = "POSTGRES_DB"; value = wcfg.postgres.database; }
                  { name = "POSTGRES_USER"; value = wcfg.postgres.user; }
                  {
                    name = "POSTGRES_PASSWORD";
                    valueFrom.secretKeyRef = {
                      inherit (wcfg.postgres.passwordSecret) name key;
                    };
                  }
                  # Keep PGDATA in a subdir so the volume's lost+found doesn't
                  # collide with initdb.
                  { name = "PGDATA"; value = "/var/lib/postgresql/data/pgdata"; }
                ];
                volumeMounts = [{ name = "data"; mountPath = "/var/lib/postgresql/data"; }];
                readinessProbe.exec.command = [ "pg_isready" "-U" wcfg.postgres.user "-d" wcfg.postgres.database ];
                livenessProbe.exec.command = [ "pg_isready" "-U" wcfg.postgres.user "-d" wcfg.postgres.database ];
              };
              volumes = [{
                name = "data";
                persistentVolumeClaim.claimName = "agent-shared-db";
              }];
            };
          };
        };
      };

      services.agent-shared-db = {
        metadata = { name = "agent-shared-db"; namespace = cfg.namespace; };
        spec = {
          selector.app = "agent-shared-db";
          ports = [{ port = 5432; targetPort = "pg"; name = "pg"; }];
        };
      };
    })
    (lib.mkIf wcfg.ingress.enable {
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
    })
    ];

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
