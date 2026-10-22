# Shared-database migration Job: applies the Atlas migrations under lib/sql to
# the per-service databases on deploy.
#
# The agent-db-migrator image runs `atlas migrate apply --baseline` against each
# database, connecting as that database's own consumer role. A `wait-for-db`
# initContainer gates it on agent-postgres-init having created those databases
# and roles, and the Job's name hashes its spec because a pod template is
# immutable.

{ config, lib, kubenix, ... }:

let
  cfg = config.scooter;
  mcfg = cfg.dbMigrate;
  pcfg = cfg.postgres;
  ns = cfg.namespace;

  # Every database with an Atlas schema that this deployment provisions: a
  # consumer's own database (its role is named after it), or an extra database
  # owned by an existing consumer's role (a contrib database). `key` names the
  # agent-pg-<key> Secret holding the role's password.
  targets =
    lib.mapAttrsToList (k: c: { inherit (c) db user; key = k; })
      (lib.filterAttrs (_k: c: builtins.elem c.db cfg.dbSpec.databases) pcfg.consumers)
    ++ lib.mapAttrsToList (db: d: { inherit db; user = pcfg.consumers.${d.owner}.user; key = d.owner; })
      (lib.filterAttrs (db: _: builtins.elem db cfg.dbSpec.databases) pcfg.databases);
  migrated = map (t: t.db) targets;

  # One-time row copies, kept only where both databases are migrated here and share
  # an owner role (the copy connects to both as that one role).
  userOf = db: (lib.findFirst (t: t.db == db) null targets).user;
  copies = lib.filter
    (c: builtins.elem c.db migrated && builtins.elem c.from migrated
      && (if userOf c.db == userOf c.from then true
          else throw "scooter.db.${c.db}.tables.${c.table}.copyFrom = ${c.from}: the two databases have different owner roles, so the migrator cannot copy between them."))
    cfg.dbSpec.copies;

  # The env var the migrator script looks up per ROLE, mirroring its own
  # `tr '[:lower:]-' '[:upper:]_'`.
  pwEnvOf = user: "${lib.toUpper (builtins.replaceStrings [ "-" ] [ "_" ] user)}_DB_PASSWORD";
  # A shell reference to that var, since BusyBox ash has no `${"$"}{!var}` indirection.
  pwRefOf = user: "$" + pwEnvOf user;

  # The password env shared by the gate initContainer and the migrator, one per
  # role however many databases it owns.
  pwEnv = map
    (t: {
      name = pwEnvOf t.user;
      valueFrom.secretKeyRef = { name = "agent-pg-${t.key}"; key = "password"; };
    })
    (lib.unique (map (t: { inherit (t) user key; }) targets));

  # Waits for each database and role to exist with a real connect as the role the
  # migrator itself uses.
  waitScript = ''
    set -eu
  '' + lib.optionalString (pcfg.sslmode != null) ''
    export PGSSLMODE="${pcfg.sslmode}"
  '' + lib.concatMapStrings
    (t:
      let inherit (t) db user; in ''
        echo "[${db}] waiting for database + role ..."
        n=0
        until PGPASSWORD="${pwRefOf user}" psql -h "${pcfg.host}" -p "${toString pcfg.port}" \
          -U "${user}" -d "${db}" -tAc 'SELECT 1' >/dev/null 2>&1; do
          n=$((n + 1))
          if [ "$n" -ge 150 ]; then
            echo "[${db}] still unreachable after $n attempts (~5m) — giving up" >&2
            exit 1
          fi
          sleep 2
        done
        echo "[${db}] ready"
      '')
    targets + ''
    echo "all target databases reachable"
  '';

  # Stable identity for selectors and logs, independent of the hashed name.
  jobLabels = {
    "app.kubernetes.io/name" = "agent-db-migrate";
    "app.kubernetes.io/component" = "migration";
  };

  jobSpec = {
    # Retries only cover a genuinely failing migration.
    backoffLimit = 3;
    # Reap a superseded Job after a day, leaving time to read its logs.
    ttlSecondsAfterFinished = 86400;
    template = {
      metadata.labels = jobLabels;
      spec = {
        restartPolicy = "OnFailure";
        # The postgres image carries the psql client the gate needs.
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
            { name = "DB_ENVS"; value = lib.concatStringsSep " " (map (t: "${t.db}:${t.user}") targets); }
          ]
          ++ lib.optional (pcfg.sslmode != null) { name = "DB_SSLMODE"; value = pcfg.sslmode; }
          ++ lib.optional (copies != [ ]) { name = "DB_COPIES"; value = lib.concatMapStringsSep " " (c: "${c.db}:${c.table}:${c.from}") copies; }
          ++ lib.optional (copies != [ ] && mcfg.retireCopiedTables) { name = "DB_RETIRE_COPIED"; value = "1"; }
          # The var name derives from the db name and the Secret from the consumer key.
          ++ pwEnv;
        };
      };
    };
  };

  # A Job's spec.template is immutable, so hashing makes a spec change a create
  # while an unchanged spec keeps its name.
  jobName = kubenix.lib.k8s.mkNameHash { name = "agent-db-migrate"; data = jobSpec; };
in
{
  options.scooter.dbMigrate = with lib; {
    enable = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Run the shared-database migration Job on deploy (applies lib/sql migrations
        via Atlas). Only databases with an Atlas schema that are also provisioned
        (a postgres consumer) are migrated; with none, no Job is rendered.
      '';
    };
    retireCopiedTables = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Drop the source table of every `copyFrom` copy (today broker's `annotations`
        and `permission_requests`) after the copy runs. The migrator first checks
        that every source primary key is in the new database, and fails the Job
        instead of dropping if any row is missing. Set it per deployment once release
        N's copy has run and the moved data checks out. Temporary: it is removed,
        with the tables, once every deployment has set it.
      '';
    };
    image = mkOption {
      type = types.str;
      default = cfg.images.agent-db-migrator.ref.fullUrl;
      defaultText = literalExpression "config.scooter.images.agent-db-migrator.ref.fullUrl";
      description = "OCI ref of the db-migrator image.";
    };
  };

  config = lib.mkMerge [
    (lib.mkIf (mcfg.enable && targets != [ ]) {
    # The Nix attr name stays fixed (it is what other modules would reference);
    # metadata.name is the hashed one that actually lands in the cluster.
    kubernetes.resources.jobs.agent-db-migrate = {
      metadata = {
        name = jobName;
        namespace = ns;
        labels = jobLabels;
        annotations."agent-sandbox/migrates" = lib.concatStringsSep "," (map (t: t.db) targets);
      };
      spec = jobSpec;
    };
  })
  ];
}
