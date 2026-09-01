# Shared-database migration Job — applies the Atlas migrations under lib/sql to the
# per-service databases on deploy.
#
# Tables are declared once in lib/sql/<db>/schema.sql and their migrations live in
# lib/sql/<db>/migrations (Atlas-owned). This Job runs the agent-db-migrator image,
# which does `atlas migrate apply --baseline <baseline>` against each database.
# `--baseline` adopts the tables production already has (created by the services'
# own inline DDL during the transition) on the first deploy without re-running the
# baseline, then applies any later migrations — so the same Job is safe every deploy.
#
# It connects as each per-consumer role (agent-pg-<db>) to that role's database, so
# it can only touch a database it owns. It runs alongside the services' own table
# creation for now; the services stop self-creating tables in a later phase.

{ config, lib, ... }:

let
  cfg = config.agentSandbox;
  mcfg = cfg.dbMigrate;
  pcfg = cfg.postgres;
  ns = cfg.namespace;

  # The databases that have an Atlas schema here AND are provisioned in this deploy
  # (postgres.nix only lists a consumer when its feature is enabled).
  #
  # Matched on the CONSUMER KEY, which is not always the database name: agent-host
  # registers `consumers.agent-host = { db = "agent_host"; … }`. The key names the
  # per-consumer Secret (agent-pg-<key>); `c.db` names the database, the role, and
  # the lib/sql directory. Keying the filter on the db name instead silently drops
  # agent-host, whose tables NOTHING then creates (its stores stopped self-creating
  # in #425) — so the Job must iterate keys and resolve `c.db` for everything else.
  candidates = [ "webhooks" "scheduler" "broker" "byoc" "agent-host" ];
  enabledKeys = builtins.filter (k: pcfg.consumers ? ${k}) candidates;
  # key -> the database/role/sql-dir name.
  dbOf = k: pcfg.consumers.${k}.db;
  # DB NAME -> the env var the migrator script looks up. Mirror the script's own
  # `tr '[:lower:]-' '[:upper:]_'` so the two always agree; a bare lib.toUpper would
  # emit AGENT-HOST_DB_PASSWORD for a hyphenated name, which is not a legal env name.
  pwEnvOf = db: "${lib.toUpper (builtins.replaceStrings [ "-" ] [ "_" ] db)}_DB_PASSWORD";
in
{
  options.agentSandbox.dbMigrate = with lib; {
    enable = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Run the shared-database migration Job on deploy (applies lib/sql migrations
        via Atlas). Only databases with an Atlas schema that are also provisioned
        (a postgres consumer) are migrated; with none, no Job is rendered.
      '';
    };
    image = mkOption {
      type = types.str;
      default = "${cfg.registryPrefix}agent-db-migrator:latest";
      defaultText = literalExpression ''"''${registryPrefix}agent-db-migrator:latest"'';
      description = "OCI ref of the db-migrator image.";
    };
  };

  config = lib.mkIf (mcfg.enable && enabledKeys != [ ]) {
    kubernetes.resources.jobs.agent-db-migrate = {
      metadata = {
        name = "agent-db-migrate";
        namespace = ns;
        annotations."agent-sandbox/migrates" = lib.concatStringsSep "," (map dbOf enabledKeys);
      };
      spec = {
        # Generous retries: the per-consumer databases/roles are created by the
        # agent-postgres-init Job, which has no ordering guarantee relative to this
        # one — the image also retries internally, but let the Job recover too.
        backoffLimit = 10;
        template.spec = {
          restartPolicy = "OnFailure";
          containers.migrate = {
            name = "migrate";
            image = mcfg.image;
            imagePullPolicy = cfg.pullPolicy;
            env = [
              { name = "DB_HOST"; value = pcfg.host; }
              { name = "DB_PORT"; value = toString pcfg.port; }
              { name = "DB_ENVS"; value = lib.concatStringsSep " " (map dbOf enabledKeys); }
            ]
            ++ lib.optional (pcfg.sslmode != null) { name = "DB_SSLMODE"; value = pcfg.sslmode; }
            # The script derives its var name from the DB name in DB_ENVS, while the
            # Secret is named for the consumer KEY — so resolve each side separately
            # rather than assuming they are the same string.
            ++ map
              (k: {
                name = pwEnvOf (dbOf k);
                valueFrom.secretKeyRef = { name = "agent-pg-${k}"; key = "password"; };
              })
              enabledKeys;
          };
        };
      };
    };
  };
}
