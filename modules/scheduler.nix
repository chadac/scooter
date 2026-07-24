# Scheduler — Deployment + Service + ServiceAccount.
#
# Fires scheduled tasks on a cron schedule by POSTing each run's prompt to the
# agent-host /agui (a fresh conversation per run). Presents a projected SA token
# (audience agent-host) so the agent-host honors the task `owner` — the scheduler's
# SA is added to the agent-host WEBHOOKS_SERVICE_ACCOUNT trust list (platform.nix).
#
# Store: SQLite on an emptyDir by default (single-replica local; tasks lost on
# restart). Point DSN/DB_PASSWORD at the shared Postgres (agent-shared-db, deployed
# by the webhooks postgres block) for durability + multi-replica.

{ config, lib, ... }:

let
  cfg = config.agentSandbox;
  scfg = cfg.scheduler;
in
{
  options.agentSandbox.scheduler = with lib; {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "Deploy the scheduled-tasks service (cron-spawns conversations).";
    };
    image = mkOption {
      type = types.str;
      default = "${cfg.registryPrefix}agent-scheduler:latest";
      defaultText = literalExpression ''"''${registryPrefix}agent-scheduler:latest"'';
      description = "OCI ref of the scheduler image.";
    };
    tickSeconds = mkOption {
      type = types.int;
      default = 30;
      description = "How often the scheduler loop checks for due tasks.";
    };
    relayKey = mkOption {
      type = types.str;
      default = "";
      description = ''
        API key gating the /tasks API (Bearer). Empty = auth disabled (local only).
        For a real deploy, set via a Secret + envFrom, not inline.
      '';
    };
    # Shared-Postgres wiring (mirror webhooks): set passwordSecret to point DSN at
    # agent-shared-db (deployed by agentSandbox.webhooks.postgres). Unset -> SQLite.
    postgres = {
      passwordSecret = mkOption {
        type = types.nullOr (types.submodule {
          options = {
            name = mkOption { type = types.str; };
            key = mkOption { type = types.str; default = "password"; };
          };
        });
        default = null;
        description = "Secret holding the shared-DB password. Set -> Postgres DSN assembled; unset -> SQLite.";
      };
      user = mkOption { type = types.str; default = "scheduler"; };
      database = mkOption { type = types.str; default = "scheduler"; };
    };
  };

  config = lib.mkIf scfg.enable {
    kubernetes.resources = {
      serviceAccounts.agent-scheduler = {
        metadata = { name = "agent-scheduler"; namespace = cfg.namespace; };
      };

      deployments.agent-scheduler = {
        metadata = { name = "agent-scheduler"; namespace = cfg.namespace; };
        spec = {
          # Single replica: the SQLite default is per-pod, and the loop is cheap.
          # For multi-replica, use Postgres (due_tasks uses FOR UPDATE SKIP LOCKED).
          replicas = 1;
          selector.matchLabels.app = "agent-scheduler";
          template = {
            metadata.labels.app = "agent-scheduler";
            spec = {
              serviceAccountName = "agent-scheduler";
              containers.agent-scheduler = {
                name = "agent-scheduler";
                image = scfg.image;
                imagePullPolicy = cfg.pullPolicy;
                command = [ "agent-scheduler" ];
                resources = lib.mkDefault {
                  requests = { cpu = "50m"; memory = "128Mi"; };
                  limits = { memory = "512Mi"; };
                };
                ports = [{ containerPort = 8080; name = "http"; }];
                env = [
                  { name = "AGENT_HOST_URL"; value = "http://agent-host.${cfg.namespace}.svc.cluster.local:8080"; }
                  { name = "TICK_SECONDS"; value = toString scfg.tickSeconds; }
                  { name = "SA_TOKEN_PATH"; value = "/var/run/secrets/agent-host/token"; }
                ] ++ lib.optional (scfg.relayKey != "") { name = "RELAY_KEY"; value = scfg.relayKey; }
                ++ (if scfg.postgres.passwordSecret != null then [
                  { name = "DB_HOST"; value = "agent-shared-db.${cfg.namespace}.svc.cluster.local"; }
                  { name = "DB_USER"; value = scfg.postgres.user; }
                  { name = "DB_NAME"; value = scfg.postgres.database; }
                  {
                    name = "DB_PASSWORD";
                    valueFrom.secretKeyRef = { inherit (scfg.postgres.passwordSecret) name key; };
                  }
                ] else [
                  # Ephemeral SQLite on the emptyDir (dev/single-pod; lost on restart).
                  { name = "DSN"; value = "sqlite+aiosqlite:////data/scheduler.db"; }
                ]);
                volumeMounts = [
                  { name = "data"; mountPath = "/data"; }
                  # Projected SA token (audience agent-host) → /agui owner trust.
                  { name = "agent-host-token"; mountPath = "/var/run/secrets/agent-host"; readOnly = true; }
                ];
                readinessProbe.httpGet = { path = "/healthz"; port = "http"; };
                livenessProbe.httpGet = { path = "/healthz"; port = "http"; };
              };
              volumes = [
                { name = "data"; emptyDir = { }; }
                {
                  name = "agent-host-token";
                  projected.sources = [{
                    serviceAccountToken = { audience = "agent-host"; path = "token"; expirationSeconds = 3600; };
                  }];
                }
              ];
            };
          };
        };
      };

      services.agent-scheduler = {
        metadata = { name = "agent-scheduler"; namespace = cfg.namespace; };
        spec = {
          selector.app = "agent-scheduler";
          ports = [{ port = 8080; targetPort = "http"; name = "http"; }];
        };
      };
    };
  };
}
