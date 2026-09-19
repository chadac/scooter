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
#
# A `wait-for-db` initContainer gates the Job on those databases/roles actually
# existing — agent-postgres-init creates them and nothing sequences the two Jobs.
#
# The Job's NAME carries a hash of its spec, because a Job's pod template is
# immutable — see `jobName` below.

{ config, lib, kubenix, ... }:

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
  # A SHELL reference to that var ("$WEBHOOKS_DB_PASSWORD"), built in Nix so the
  # generated script never needs `${!var}` indirection — the wait image's /bin/sh is
  # BusyBox ash, which has no such expansion.
  pwRefOf = db: "$" + pwEnvOf db;

  # The per-consumer password env, shared by the gate initContainer and the migrator:
  # both connect as the same roles, so they must read the same Secrets.
  pwEnv = map
    (k: {
      name = pwEnvOf (dbOf k);
      valueFrom.secretKeyRef = { name = "agent-pg-${k}"; key = "password"; };
    })
    enabledKeys;

  # ORDERING GATE. agent-postgres-init creates each per-consumer database + role; this
  # Job connects AS those roles. Nothing sequences the two Jobs, so the migrator used to
  # discover the gap by failing: ~30 internal retries per database, times the Job's own
  # backoff, each printing the connection error — the bulk of a deploy's error-level log
  # volume, and pure noise since the only cure was waiting.
  #
  # So wait HERE instead, in an initContainer, where a not-yet-provisioned database is a
  # quiet expected state rather than an error. The probe is a real connect as the
  # consumer role to its own database — NOT pg_isready, which reports the SERVER as
  # accepting connections while the role and database still do not exist, i.e. it goes
  # green exactly when the gate must still be closed.
  #
  # Identity note: the probe uses the DATABASE name as the role name because the migrator
  # does (`postgres://$env:$pw@…/$env`). Resolving `.user` here instead could let the gate
  # pass with a role the migrator never uses.
  waitScript = ''
    set -eu
  '' + lib.optionalString (pcfg.sslmode != null) ''
    export PGSSLMODE="${pcfg.sslmode}"
  '' + lib.concatMapStrings
    (k:
      let db = dbOf k; in ''
        echo "[${db}] waiting for database + role ..."
        n=0
        until PGPASSWORD="${pwRefOf db}" psql -h "${pcfg.host}" -p "${toString pcfg.port}" \
          -U "${db}" -d "${db}" -tAc 'SELECT 1' >/dev/null 2>&1; do
          n=$((n + 1))
          if [ "$n" -ge 150 ]; then
            echo "[${db}] still unreachable after $n attempts (~5m) — giving up" >&2
            exit 1
          fi
          sleep 2
        done
        echo "[${db}] ready"
      '')
    enabledKeys + ''
    echo "all target databases reachable"
  '';

  # Stable identity for humans and selectors, independent of the hashed name below:
  # `kubectl -n … logs -l app.kubernetes.io/name=agent-db-migrate` finds this deploy's
  # migrator without anyone having to look up the current hash.
  jobLabels = {
    "app.kubernetes.io/name" = "agent-db-migrate";
    "app.kubernetes.io/component" = "migration";
  };

  jobSpec = {
    # Ordering is the `wait-for-db` initContainer's job now, not the backoff's, so
    # these retries only cover a genuinely failing migration — where 10 attempts
    # just reprint the same error 10 times. Why: PR #533.
    backoffLimit = 3;
    # Each spec change leaves the PREVIOUS hash-named Job behind under a deploy that
    # does not prune (kubectl apply); this reaps it a day later, which is long enough
    # to read the pod logs after a bad deploy.
    ttlSecondsAfterFinished = 86400;
    template = {
      metadata.labels = jobLabels;
      spec = {
        restartPolicy = "OnFailure";
        # Block until every target database + role exists (see waitScript). Needs a
        # psql client, which the migrator image does not carry — the postgres image
        # does, and is already pulled on every node running the shared server.
        initContainers = [{
          name = "wait-for-db";
          image = pcfg.image;
          command = [ "/bin/sh" "-c" waitScript ];
          env = pwEnv;
        }];
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
          ++ pwEnv;
        };
      };
    };
  };

  # The spec IS the Job's identity, because a Job's spec.template is IMMUTABLE: a
  # CHANGED Job re-applied under a FIXED name is rejected apiserver-side, which fails
  # the whole deploy (helm: UPGRADE FAILED mid-roll) and never runs the migration.
  # Hashing makes a spec change a CREATE; an unchanged spec keeps its name, so a no-op
  # deploy does not re-run. Why: PR #542.
  jobName = kubenix.lib.k8s.mkNameHash { name = "agent-db-migrate"; data = jobSpec; };
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
    # The Nix attr name stays fixed (it is what other modules would reference);
    # metadata.name is the hashed one that actually lands in the cluster.
    kubernetes.resources.jobs.agent-db-migrate = {
      metadata = {
        name = jobName;
        namespace = ns;
        labels = jobLabels;
        annotations."agent-sandbox/migrates" = lib.concatStringsSep "," (map dbOf enabledKeys);
      };
      spec = jobSpec;
    };
  };
}
