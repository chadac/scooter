# Scheduler — Deployment + Service + ServiceAccount.
#
# Fires scheduled tasks on a cron schedule by POSTing each run's prompt to the
# agent-host /agui (a fresh conversation per run). Presents a projected SA token
# (audience agent-host) so the agent-host honors the task `owner` — the scheduler's
# SA is added to the agent-host WEBHOOKS_SERVICE_ACCOUNT trust list (platform.nix).
#
# Store: the shared platform Postgres (agentSandbox.postgres, always on) — the
# scheduler's own `scheduler` db + auto-provisioned role. Durable across restarts.
# SQLite remains only as the app's local-dev / unit-test default (no DB_* env).

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
    runRetentionDays = mkOption {
      type = types.int;
      default = 90;
      description = "TTL for task_runs in days; 0 disables the sweep (no DELETE).";
    };
    relayKey = mkOption {
      type = types.str;
      default = "";
      description = ''
        API key gating the /tasks API (Bearer). Empty = auth disabled (local only).
        For a real deploy, set via a Secret + envFrom, not inline.
      '';
    };
    logLevel = mkOption {
      type = types.str;
      default = "INFO";
      example = "DEBUG";
      description = "Root log level (LOG_LEVEL) — INFO logs task fires/spawns; DEBUG is verbose.";
    };
    # Durability: the scheduler ALWAYS uses the shared Postgres now (agentSandbox.
    # postgres) — its own `scheduler` db + role, auto-provisioned. No per-module
    # Postgres knobs; point the platform at RDS via agentSandbox.postgres.external.
  };

  config = lib.mkIf scfg.enable {
    kubernetes.resources = {
      serviceAccounts.agent-scheduler = {
        metadata = { name = "agent-scheduler"; namespace = cfg.namespace; };
      };

      deployments.agent-scheduler = {
        metadata = { name = "agent-scheduler"; namespace = cfg.namespace; };
        spec = {
          # 2 replicas by default (consolidation resilience). Safe on Postgres: the
          # loop uses claim_due, which advances next_run_at atomically under
          # FOR UPDATE SKIP LOCKED, so each due task fires on exactly one replica (no
          # double-fire). With the SQLite dev default there's a single pod anyway.
          replicas = cfg.statelessReplicas;
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
                  { name = "RUN_RETENTION_DAYS"; value = toString scfg.runRetentionDays; }
                  { name = "SA_TOKEN_PATH"; value = "/var/run/secrets/agent-host/token"; }
                  { name = "LOG_LEVEL"; value = scfg.logLevel; }
                ] ++ lib.optional (scfg.relayKey != "") { name = "RELAY_KEY"; value = scfg.relayKey; }
                ++ lib.optionals cfg.observability.otel.enable ([
                  # OTel metrics ON. The OTLP endpoint/headers come from the standard
                  # OTEL_EXPORTER_OTLP_* env (the SDK reads them).
                  { name = "OTEL_METRICS_ENABLED"; value = "1"; }
                  { name = "OTEL_SERVICE_NAME"; value = "agent-scheduler"; }
                ] ++ lib.mapAttrsToList (k: v: { name = k; value = v; }) cfg.observability.otel.env)
                # Durable Postgres — the shared platform DB (always on). DSN is
                # assembled app-side from these parts; the password is the scheduler's
                # OWN auto-generated role secret (agent-pg-scheduler), created by the
                # postgres module's provisioning Job.
                ++ [
                  { name = "DB_HOST"; value = cfg.postgres.host; }
                  { name = "DB_PORT"; value = toString cfg.postgres.port; }
                  { name = "DB_USER"; value = "scheduler"; }
                  { name = "DB_NAME"; value = "scheduler"; }
                  { name = "DB_PASSWORD"; valueFrom.secretKeyRef = { name = "agent-pg-scheduler"; key = "password"; }; }
                ] ++ lib.optional (cfg.postgres.sslmode != null) { name = "DB_SSLMODE"; value = cfg.postgres.sslmode; };
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

    # Register with the shared Postgres so the provisioning Job creates the
    # `scheduler` database + a `scheduler` role that owns it (agent-pg-scheduler).
    agentSandbox.postgres.consumers.scheduler = { db = "scheduler"; user = "scheduler"; };
  };
}
