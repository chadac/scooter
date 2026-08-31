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
  candidates = [ "webhooks" "scheduler" "broker" "byoc" ];
  enabledEnvs = builtins.filter (e: pcfg.consumers ? ${e}) candidates;
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

  config = lib.mkIf (mcfg.enable && enabledEnvs != [ ]) {
    kubernetes.resources.jobs.agent-db-migrate = {
      metadata = {
        name = "agent-db-migrate";
        namespace = ns;
        annotations."agent-sandbox/migrates" = lib.concatStringsSep "," enabledEnvs;
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
              { name = "DB_ENVS"; value = lib.concatStringsSep " " enabledEnvs; }
            ]
            ++ lib.optional (pcfg.sslmode != null) { name = "DB_SSLMODE"; value = pcfg.sslmode; }
            ++ map
              (e: {
                name = "${lib.toUpper e}_DB_PASSWORD";
                valueFrom.secretKeyRef = { name = "agent-pg-${e}"; key = "password"; };
              })
              enabledEnvs;
          };
        };
      };
    };
  };
}
