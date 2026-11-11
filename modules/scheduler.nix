# Scheduler: Deployment, Service and ServiceAccount. It fires cron-scheduled
# tasks by POSTing each run's prompt to the agent-host /agui as a fresh
# conversation, presenting a projected SA token (audience scooter-router) so the
# agent-host honors the task `owner`. It also runs the deployment's system tasks
# (`scooter.systemTasks`) as subprocesses. State lives in the scheduler's own
# database on the shared platform Postgres.

{ config, lib, ... }:

let
  cfg = config.scooter;
  scfg = cfg.scheduler;

  # "<n>s|m|h|d" -> seconds.
  seconds = where: s:
    let
      m = builtins.match "([0-9]+)([smhd])" s;
      unit = { s = 1; m = 60; h = 3600; d = 86400; };
    in
    if m == null then throw "${where}: `${s}` is not a duration (<n>s, <n>m, <n>h or <n>d)."
    else lib.toInt (lib.head m) * unit.${lib.last m};

  enabledTasks = lib.filterAttrs (_: t: t.enable) cfg.systemTasks;
  models = cfg.agent.resolvedModels;

  # One row of the scheduler's system-tasks.json; a bad task throws, naming its option.
  renderTask = id: t:
    let
      where = "scooter.systemTasks.${id}";
      model =
        if t.model == null then models.fast
        else if models.ids == [ ] || lib.elem t.model models.ids then t.model
        else throw "${where}.model: `${t.model}` is not in scooter.agent.availableModels (have: ${lib.concatStringsSep ", " models.ids}).";
    in
    if (t.every == null) == (t.cron == null) then throw "${where}: set exactly one of `every` and `cron`."
    else {
      inherit id model;
      inherit (t) command args cron timezone;
      interval_seconds = if t.every == null then null else seconds "${where}.every" t.every;
      timeout_seconds = seconds "${where}.timeout" t.timeout;
    };

  # Context discarded: rendering manifests must not build the tasks. The image carries
  # the closures (services/scheduler/image.nix).
  systemTasksJson = builtins.unsafeDiscardStringContext
    (builtins.toJSON (lib.mapAttrsToList renderTask enabledTasks));

  taskModule = { name, ... }: {
    options = with lib; {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = "Run this task. False drops it, and the scheduler deletes its row and run history.";
      };
      command = mkOption {
        type = types.pathInStore;
        example = literalExpression "lib.getExe myTask";
        description = ''
          The executable, as a store path inside a derivation (`lib.getExe drv` or
          `"''${drv}/bin/x"`), never a bare name. Python tasks are built with
          mkScooterTask (nix/scooter-task.nix); anything that builds to an executable
          works. The scheduler image this eval builds carries its closure. The
          published image carries only the contrib registry's tasks and scooter-prompt,
          so a deployment with its own task builds and pushes its own scheduler image;
          on an image without the command, the scheduler logs the task and skips it.
        '';
      };
      args = mkOption {
        type = types.listOf types.str;
        default = [ ];
        example = literalExpression ''[ "--per-user" "--prompt-file" "''${./digest.md}" ]'';
        description = "Arguments after the command. A store path here must be in the scheduler image too.";
      };
      every = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "1h";
        description = "Run every this long (`<n>s|m|h|d`). Exactly one of `every` and `cron`.";
      };
      cron = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "0 9 * * 1";
        description = "Run on this cron schedule, read in `timezone`. Exactly one of `every` and `cron`.";
      };
      timezone = mkOption {
        type = types.str;
        default = "UTC";
        description = "The timezone `cron` is read in.";
      };
      timeout = mkOption {
        type = types.str;
        default = "10m";
        description = "SIGTERM after this long (`<n>s|m|h|d`), SIGKILL 30s later; the run is `timed_out`.";
      };
      model = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = ''
          The model this task's conversations default to (SCOOTER_TASK_MODEL), which
          must be in `scooter.agent.availableModels`. Null is the catalog's `fast`
          model, else its default, so background work never runs on whatever a user
          last picked.
        '';
      };
      contrib = mkOption {
        type = types.nullOr types.str;
        default = null;
        internal = true;
        description = "The contrib that declared this task, if any.";
      };
    };
  };
in
{
  options.scooter.systemTasks = lib.mkOption {
    type = lib.types.attrsOf (lib.types.submodule taskModule);
    default = { };
    example = lib.literalExpression ''
      {
        weekly-digest = {
          command = lib.getExe scooter.packages.''${system}.scooter-prompt;
          args = [ "--per-user" "--title" "Weekly digest" "--prompt" "Summarise my week." ];
          cron = "0 9 * * 1";
        };
      }
    '';
    description = ''
      Recurring tasks the scheduler runs as subprocesses, keyed by id: a command and
      its arguments on a schedule, one run at a time, within a timeout. A task drives
      Scooter itself (lib/py/scooter-task), e.g. spawning a conversation per user.
      Contribs add theirs as `"<contrib>-<id>"`; set a field there to tune one.
      Needs `scooter.scheduler.enable`.
    '';
  };

  options.scooter.scheduler = with lib; {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "Deploy the scheduled-tasks service (cron-spawns conversations).";
    };
    image = mkOption {
      type = types.str;
      default = cfg.images.agent-scheduler.ref.fullUrl;
      defaultText = literalExpression "config.scooter.images.agent-scheduler.ref.fullUrl";
      description = "OCI ref of the scheduler image.";
    };
    tickSeconds = mkOption {
      type = types.int;
      default = 30;
      description = "How often the scheduler loop checks for due tasks.";
    };
    systemTaskConcurrency = mkOption {
      type = types.ints.positive;
      default = 4;
      description = "At most this many system-task runs at once, across all tasks, so a slow one cannot crowd out the rest.";
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
  };

  # The table declarations are unconditional (see modules/db-spec.nix); everything else is gated on `enable`.
  config = lib.mkMerge [

  # The tables the `scheduler` database holds.
  {
    scooter.db.scheduler = {
      owner = "scheduler";
      tables = {
        scheduled_tasks = { writers = [ "scheduler" ]; };
        task_runs = { writers = [ "scheduler" ]; };
        task_run_conversations = { writers = [ "scheduler" ]; };
      };
    };
  }
  (lib.mkIf scfg.enable {
    kubernetes.resources = {
      # The deployment's system tasks, synced into scheduled_tasks at startup.
      configMaps.scheduler-system-tasks = {
        metadata = { name = "scheduler-system-tasks"; namespace = cfg.namespace; };
        data."system-tasks.json" = systemTasksJson;
      };

      serviceAccounts.agent-scheduler = {
        metadata = { name = "agent-scheduler"; namespace = cfg.namespace; };
      };

      deployments.agent-scheduler = {
        metadata = { name = "agent-scheduler"; namespace = cfg.namespace; };
        spec = {
          # Multiple replicas are safe because claim_due advances next_run_at under FOR UPDATE SKIP LOCKED.
          replicas = cfg.statelessReplicas;
          selector.matchLabels.app = "agent-scheduler";
          template = {
            metadata.labels.app = "agent-scheduler";
            # A changed task list rolls the pod, which re-syncs it.
            metadata.annotations."checksum/system-tasks" = builtins.hashString "sha256" systemTasksJson;
            spec = {
              serviceAccountName = "agent-scheduler";
              # Starts only once agent-db-migrate has applied this release.
              initContainers = cfg.schemaGate.initContainers.scheduler or [ ];
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
                  # System tasks: what to run, and the env a run inherits (lib/py/scooter-task/README.md).
                  { name = "SYSTEM_TASKS_PATH"; value = "/etc/scheduler/system-tasks/system-tasks.json"; }
                  { name = "SYSTEM_TASK_CONCURRENCY"; value = toString scfg.systemTaskConcurrency; }
                  { name = "SCHEDULER_URL"; value = "http://agent-scheduler.${cfg.namespace}.svc.cluster.local:8080"; }
                ] ++ lib.optionals cfg.broker.enable [
                  { name = "BROKER_URL"; value = "http://agent-broker.${cfg.namespace}.svc.cluster.local:8080"; }
                  { name = "BROKER_TOKEN_PATH"; value = "/var/run/secrets/broker/token"; }
                ] ++ lib.optional (scfg.relayKey != "") { name = "RELAY_KEY"; value = scfg.relayKey; }
                ++ lib.optionals cfg.observability.otel.enable ([
                  # The OTLP endpoint and headers come from the standard OTEL_EXPORTER_OTLP_* env.
                  { name = "OTEL_METRICS_ENABLED"; value = "1"; }
                  { name = "OTEL_SERVICE_NAME"; value = "agent-scheduler"; }
                ] ++ lib.mapAttrsToList (k: v: { name = k; value = v; }) cfg.observability.otel.env)
                # The DSN is assembled app-side from these parts.
                ++ [
                  { name = "DB_HOST"; value = cfg.postgres.host; }
                  { name = "DB_PORT"; value = toString cfg.postgres.port; }
                  { name = "DB_USER"; value = "scheduler"; }
                  { name = "DB_NAME"; value = "scheduler"; }
                  { name = "DB_PASSWORD"; valueFrom.secretKeyRef = { name = "agent-pg-scheduler"; key = "password"; }; }
                ] ++ lib.optional (cfg.postgres.sslmode != null) { name = "DB_SSLMODE"; value = cfg.postgres.sslmode; }
                ++ cfg.contribDbEnv.scheduler;
                volumeMounts = [
                  { name = "data"; mountPath = "/data"; }
                  # Projected SA token (audience scooter-router) for /agui owner trust.
                  { name = "agent-host-token"; mountPath = "/var/run/secrets/agent-host"; readOnly = true; }
                  { name = "system-tasks"; mountPath = "/etc/scheduler/system-tasks"; readOnly = true; }
                  # A task run's working directory, /tmp/task-<run id>.
                  { name = "tmp"; mountPath = "/tmp"; }
                ] ++ lib.optionals cfg.broker.enable [
                  # Audience agent-broker: a task calls a contrib's /system routes as the scheduler.
                  { name = "broker-token"; mountPath = "/var/run/secrets/broker"; readOnly = true; }
                ];
                readinessProbe.httpGet = { path = "/healthz"; port = "http"; };
                livenessProbe.httpGet = { path = "/healthz"; port = "http"; };
              };
              volumes = [
                { name = "data"; emptyDir = { }; }
                { name = "tmp"; emptyDir = { }; }
                { name = "system-tasks"; configMap.name = "scheduler-system-tasks"; }
                {
                  name = "agent-host-token";
                  projected.sources = [{
                    serviceAccountToken = { audience = "scooter-router"; path = "token"; expirationSeconds = 3600; };
                  }];
                }
              ] ++ lib.optional cfg.broker.enable {
                name = "broker-token";
                projected.sources = [{ serviceAccountToken = { audience = "agent-broker"; path = "token"; expirationSeconds = 3600; }; }];
              };
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

    # The provisioning Job creates the `scheduler` database and role (secret agent-pg-scheduler).
    scooter.postgres.consumers.scheduler = { db = "scheduler"; user = "scheduler"; };
  })
  ];
}
