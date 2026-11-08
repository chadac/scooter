# Shared Postgres, the platform's durable store.
#
# In-cluster mode (the default) runs a single-replica Postgres pod on a PVC behind
# the `agent-shared-db` Service; setting `external.host` skips the pod and points
# the consumers at that server instead. Either way a provisioning Job gives each
# consumer its own database and owner role, with passwords generated into
# `agent-pg-<consumer>` Secrets. platform.nix assembles the consumer set via
# `scooter.postgres.consumers`.

{ config, lib, kubenix, ... }:

let
  cfg = config.scooter;
  pcfg = cfg.postgres;
  ns = cfg.namespace;

  inCluster = pcfg.external == null;
  # The host consumers connect to.
  host = if inCluster then "agent-shared-db.${ns}.svc.cluster.local" else pcfg.external.host;
  port = if inCluster then 5432 else pcfg.external.port;

  # The admin credentials the init Job uses for CREATE ROLE/DATABASE.
  adminUser = if inCluster then "postgres" else pcfg.external.user;
  adminSecret =
    if inCluster
    then { name = "agent-pg-admin"; key = "password"; }
    else { inherit (pcfg.external.passwordSecret) name key; };

  consumers = pcfg.consumers;
  consumerNames = builtins.attrNames consumers;
  # Extra databases owned by an existing consumer's role (no role or Secret of their own).
  databases = pcfg.databases;

  # Readers are login roles granted SELECT on another consumer's database, pinned
  # read-only at the server.
  readers = pcfg.readers;
  readerNames = builtins.attrNames readers;
  # Both consumers and readers need a generated password secret.
  secretNames = consumerNames ++ readerNames;

  # Extra table grants to an existing consumer or reader role, keyed by service.
  # A service with no role here is not deployed, so its grants are dropped.
  roleOf = svc: consumers.${svc}.user or (readers.${svc}.user or null);
  grants = lib.filterAttrs (svc: _: roleOf svc != null) pcfg.grants;
  needWait = readers != { } || grants != { };

  # The provisioning Job is a kubectl initContainer that writes each password to
  # /shared/<name>.pw and a psql container that creates the roles and databases.

  # -- initContainer: kubectl only (create/reuse the per-consumer secrets) ----------
  secretsScript = ''
    set -eu
    mkdir -p /shared
  '' + lib.optionalString inCluster ''
    # The `sql` container's PGPASSWORD secretKeyRef needs this secret to exist.
    echo "waiting for agent-pg-admin secret ..."
    for i in $(seq 1 150); do
      if kubectl -n "${ns}" get secret agent-pg-admin >/dev/null 2>&1; then break; fi
      sleep 2
    done
  '' + lib.concatMapStrings (name: ''
    SECRET="agent-pg-${name}"
    if kubectl -n "${ns}" get secret "$SECRET" >/dev/null 2>&1; then
      echo "[${name}] secret $SECRET exists — reusing"
      kubectl -n "${ns}" get secret "$SECRET" -o jsonpath='{.data.password}' | base64 -d > "/shared/${name}.pw"
    else
      tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32 > "/shared/${name}.pw"
      kubectl -n "${ns}" create secret generic "$SECRET" --from-literal=password="$(cat /shared/${name}.pw)"
      echo "[${name}] created secret $SECRET"
    fi
  '') secretNames;

  # -- main container: psql only (create roles + databases from the .pw files) -------
  sqlScript = ''
    set -eu
    export PGHOST="${host}" PGPORT="${toString port}" PGUSER="${adminUser}" PGDATABASE=postgres
    # PGPASSWORD is injected from the admin secret via env.
    echo "waiting for postgres at $PGHOST:$PGPORT ..."
    for i in $(seq 1 60); do
      if pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1; then break; fi
      sleep 2
    done
  '' + lib.optionalString inCluster ''
    # Query stats for every database, read from the postgres db.
    psql -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements'
  '' + lib.optionalString needWait ''
    # Reader tables come from agent-db-migrate, which runs alongside this Job, so
    # wait for each in-process rather than crash-looping through kubelet backoff.
    wait_table() {
      n=0
      until [ "$(psql -d "$1" -tAc "SELECT to_regclass('public.\"$2\"') IS NOT NULL" 2>/dev/null)" = "t" ]; do
        n=$((n + 1))
        if [ "$n" -ge 300 ]; then
          echo "[$1] table $2 still missing after ~10m (has agent-db-migrate run?), giving up" >&2
          exit 1
        fi
        sleep 2
      done
    }
  '' + lib.concatMapStrings (name:
    let c = consumers.${name}; in ''
    # ---- consumer ${name}: db=${c.db} user=${c.user} ----
    PW=$(cat "/shared/${name}.pw")
    # Create the role if missing, else reset its password to the secret's.
    psql -v ON_ERROR_STOP=1 -v pw="$PW" <<'SQL'
    SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', '${c.user}', :'pw')
      WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${c.user}') \gexec
    SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', '${c.user}', :'pw')
      WHERE EXISTS (SELECT FROM pg_roles WHERE rolname = '${c.user}') \gexec
    SQL
    # CREATE DATABASE cannot run inside a transaction, so gate it in the shell.
    if [ "$(psql -tAc "SELECT 1 FROM pg_database WHERE datname='${c.db}'")" != "1" ]; then
      psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE "${c.db}" OWNER "${c.user}"'
      echo "[${name}] created database ${c.db}"
    fi
  '') consumerNames
  # Extra databases come after the consumer loop that creates their owner roles.
  + lib.concatMapStrings (name:
    let d = databases.${name}; owner = consumers.${d.owner}.user; in ''
    # ---- database ${name}: owner=${owner} (consumer ${d.owner}) ----
    if [ "$(psql -tAc "SELECT 1 FROM pg_database WHERE datname='${name}'")" != "1" ]; then
      psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE "${name}" OWNER "${owner}"'
      echo "[${name}] created database ${name} owned by ${owner}"
    fi
  '') (builtins.attrNames databases)
  # Readers grant on databases the consumer loop above creates, so they come after it.
  + lib.concatMapStrings (name:
    let r = readers.${name}; in ''
    # ---- reader ${name}: role=${r.user} SELECT on ${toString (builtins.length r.grants)} db(s) (+ any writeTables) ----
    PW=$(cat "/shared/${name}.pw")
    # Create the role if missing, else reset its password to the secret's.
    psql -v ON_ERROR_STOP=1 -v pw="$PW" <<'SQL'
    SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', '${r.user}', :'pw')
      WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${r.user}') \gexec
    SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', '${r.user}', :'pw')
      WHERE EXISTS (SELECT FROM pg_roles WHERE rolname = '${r.user}') \gexec
    SQL
    # Server-side read-only default; only a writeTables pool overrides it.
    psql -v ON_ERROR_STOP=1 -c 'ALTER ROLE "${r.user}" SET default_transaction_read_only = on'
  '' + lib.concatMapStrings (g: ''
    # Grants are per named table so a later migration's table is opt-in, never
    # silently readable.
    psql -v ON_ERROR_STOP=1 -c 'GRANT CONNECT ON DATABASE "${g.db}" TO "${r.user}"'
    psql -v ON_ERROR_STOP=1 -d "${g.db}" -c 'GRANT USAGE ON SCHEMA public TO "${r.user}"'
  '' + lib.concatMapStrings (t: ''
    wait_table "${g.db}" "${t}"
    psql -v ON_ERROR_STOP=1 -d "${g.db}" -c 'GRANT SELECT ON TABLE public."${t}" TO "${r.user}"'
  '') g.tables + lib.concatMapStrings (t: ''
    # A writer of this table per owners.toml.
    wait_table "${g.db}" "${t}"
    psql -v ON_ERROR_STOP=1 -d "${g.db}" -c 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."${t}" TO "${r.user}"'
  '') g.writeTables + ''
    echo "[${name}] granted SELECT on ${g.db}.{${lib.concatStringsSep "," g.tables}}${lib.optionalString (g.writeTables != []) " + read-write on {${lib.concatStringsSep "," g.writeTables}}"} to ${r.user}"
  '') r.grants) readerNames
  # Grants to existing roles come last: they need the reader roles and every database.
  + lib.concatMapStrings (svc:
    let role = roleOf svc; in lib.concatMapStrings (g: ''
    # ---- grant ${svc}: role=${role} on ${g.db} ----
    psql -v ON_ERROR_STOP=1 -c 'GRANT CONNECT ON DATABASE "${g.db}" TO "${role}"'
    psql -v ON_ERROR_STOP=1 -d "${g.db}" -c 'GRANT USAGE ON SCHEMA public TO "${role}"'
  '' + lib.concatMapStrings (t: ''
    wait_table "${g.db}" "${t}"
    psql -v ON_ERROR_STOP=1 -d "${g.db}" -c 'GRANT SELECT ON TABLE public."${t}" TO "${role}"'
  '') g.tables + lib.concatMapStrings (t: ''
    wait_table "${g.db}" "${t}"
    psql -v ON_ERROR_STOP=1 -d "${g.db}" -c 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."${t}" TO "${role}"'
  '') g.writeTables) grants.${svc}) (builtins.attrNames grants);

  # Stable identity for selectors and logs, independent of the hashed name.
  initJobLabels = {
    "app.kubernetes.io/name" = "agent-postgres-init";
    "app.kubernetes.io/component" = "provisioning";
  };

  initJobSpec = {
    backoffLimit = 6;
    # Reap a superseded Job after a day, leaving time to read its logs.
    ttlSecondsAfterFinished = 86400;
    template = {
      metadata.labels = initJobLabels;
      spec = {
        serviceAccountName = "agent-postgres-init";
        restartPolicy = "OnFailure";
        # kubectl step: create or reuse the secrets and drop the passwords on /shared.
        initContainers = [{
          name = "secrets";
          image = pcfg.kubectlImage;
          command = [ "/bin/sh" "-c" secretsScript ];
          volumeMounts = [{ name = "shared"; mountPath = "/shared"; }];
        }];
        # psql step: create the roles and databases.
        containers.sql = {
          name = "sql";
          image = pcfg.image;
          command = [ "/bin/sh" "-c" sqlScript ];
          env = [
            { name = "PGPASSWORD"; valueFrom.secretKeyRef = { inherit (adminSecret) name key; }; }
          ];
          volumeMounts = [{ name = "shared"; mountPath = "/shared"; }];
        };
        volumes = [{ name = "shared"; emptyDir = { }; }];
      };
    };
  };

  # A Job's spec.template is immutable, so the name hashes the spec and a new
  # consumer or reader gets a new Job.
  initJobName = kubenix.lib.k8s.mkNameHash { name = "agent-postgres-init"; data = initJobSpec; };
in
{
  options.scooter.postgres = with lib; {
    image = mkOption {
      type = types.str;
      default = "postgres:16-alpine";
      description = "Postgres image for the in-cluster server (ignored when `external` is set).";
    };
    kubectlImage = mkOption {
      type = types.str;
      # Needs kubectl plus a shell and coreutils (tr/base64/head).
      default = "alpine/k8s:1.30.0";
      description = "Image for the provisioning Job's secret-creating initContainer (needs kubectl + a shell + coreutils).";
    };
    maxConnections = mkOption {
      type = types.ints.positive;
      default = 300;
      description = ''
        Postgres `max_connections` for the in-cluster server (ignored when `external` is set).
        Every service replica holds its own connection pools, so a rolling deploy briefly
        doubles the count; the stock default of 100 runs out and turns are lost.
      '';
    };
    storage = mkOption {
      type = types.str;
      default = "2Gi";
      description = "PVC size for the in-cluster Postgres data volume.";
    };
    storageClass = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "PVC storageClassName (null = cluster default).";
    };
    external = mkOption {
      default = null;
      description = ''
        Point every consumer at an EXTERNAL Postgres (RDS, etc.) instead of the
        in-cluster pod. Setting this SKIPS the in-cluster Deployment/PVC/Service; the
        provisioning Job still runs (against the external server) to create the
        per-consumer databases/roles. `passwordSecret` + `user` are the ADMIN
        credentials the Job uses (needs CREATEDB/CREATEROLE).
      '';
      type = types.nullOr (types.submodule {
        options = {
          host = mkOption { type = types.str; description = "External Postgres host."; };
          port = mkOption { type = types.int; default = 5432; description = "Port."; };
          sslmode = mkOption {
            type = types.nullOr types.str;
            default = null;
            example = "require";
            description = "sslmode appended to consumer DSNs (e.g. require).";
          };
          user = mkOption { type = types.str; default = "postgres"; description = "Admin/master user (CREATEDB/CREATEROLE)."; };
          passwordSecret = mkOption {
            type = types.submodule {
              options = {
                name = mkOption { type = types.str; };
                key = mkOption { type = types.str; default = "password"; };
              };
            };
            description = "Secret + key holding the external admin password.";
          };
        };
      });
    };
    # Populated by platform.nix from the enabled features.
    consumers = mkOption {
      internal = true;
      default = { };
      description = "Per-consumer { db; user; } map — assembled by platform.nix.";
      type = types.attrsOf (types.submodule {
        options = {
          db = mkOption { type = types.str; };
          user = mkOption { type = types.str; };
        };
      });
    };
    # Populated by the contrib glue (modules/contrib-db.nix).
    databases = mkOption {
      internal = true;
      default = { };
      description = ''
        Extra databases owned by an EXISTING consumer's role, keyed by database name.
        No role or Secret is created: a `consumers` entry would get its own Secret, and
        the provisioning Job resets the role's password to it, rotating the owner's
        password out from under its service. Used for contrib databases, which stay on
        their host service's role.
      '';
      type = types.attrsOf (types.submodule {
        options.owner = mkOption {
          type = types.str;
          description = "The `consumers` key whose role owns this database.";
        };
      });
    };
    # Populated by the contrib glue (modules/contrib-db.nix).
    grants = mkOption {
      internal = true;
      default = { };
      description = ''
        Per service, extra table-scoped grants on its EXISTING role (a `consumers` or
        `readers` key) in a database it does not own. No role or Secret is created.
        Grants for a service with no role (not deployed) are skipped.
      '';
      type = types.attrsOf (types.listOf (types.submodule {
        options = {
          db = mkOption { type = types.str; description = "The database holding the tables."; };
          tables = mkOption { type = types.listOf types.str; default = [ ]; description = "Tables to grant SELECT on."; };
          writeTables = mkOption { type = types.listOf types.str; default = [ ]; description = "Tables to grant SELECT/INSERT/UPDATE/DELETE on."; };
        };
      }));
    };
    # Populated by platform.nix.
    readers = mkOption {
      internal = true;
      default = { };
      description = ''
        Per-reader { user; grants = [ { db; tables = [ … ]; } … ]; } map — a SELECT-only login
        role granted on SPECIFIC tables of one or more existing consumer databases. Assembled by
        platform.nix, not by deployers. The role owns nothing, is pinned
        default_transaction_read_only, and reuses a single agent-pg-<key> secret across all its
        grants (one role, one password, many read grants). Grants are table-scoped on purpose:
        the reader must not gain another table's rows just because it shares a database, and a
        table added later is opt-in (extend `tables` here AND owners.toml's readers list) rather
        than silently readable.
      '';
      type = types.attrsOf (types.submodule {
        options = {
          user = mkOption { type = types.str; description = "The login role name (read-only by default; writeTables opt into writes)."; };
          grants = mkOption {
            description = "Per-database sets of tables this role may SELECT from (tables) and read-write (writeTables).";
            type = types.listOf (types.submodule {
              options = {
                db = mkOption { type = types.str; description = "The database holding the tables."; };
                tables = mkOption { type = types.listOf types.str; description = "The tables to grant SELECT on (must match owners.toml readers)."; };
                writeTables = mkOption {
                  type = types.listOf types.str;
                  default = [ ];
                  description = "Tables to also grant INSERT/UPDATE/DELETE on (must match owners.toml writers). Role default stays read-only; the writer opens a pool that overrides it.";
                };
              };
            });
          };
        };
      });
    };
    # Read-only outputs for other modules.
    host = mkOption { internal = true; readOnly = true; type = types.str; default = host; };
    port = mkOption { internal = true; readOnly = true; type = types.int; default = port; };
    sslmode = mkOption {
      internal = true; readOnly = true; type = types.nullOr types.str;
      default = if inCluster then null else pcfg.external.sslmode;
    };
  };

  config = {
    kubernetes.resources = lib.mkMerge [
      # -- The provisioning Job + its RBAC (always, in-cluster or external) ----------
      (lib.mkIf (consumers != { } || readers != { }) {
        serviceAccounts.agent-postgres-init = {
          metadata = { name = "agent-postgres-init"; namespace = ns; };
        };
        # The Job creates the per-consumer Secrets.
        roles.agent-postgres-init = {
          metadata = { name = "agent-postgres-init"; namespace = ns; };
          rules = [{
            apiGroups = [ "" ];
            resources = [ "secrets" ];
            verbs = [ "get" "create" ];
          }];
        };
        roleBindings.agent-postgres-init = {
          metadata = { name = "agent-postgres-init"; namespace = ns; };
          roleRef = { apiGroup = "rbac.authorization.k8s.io"; kind = "Role"; name = "agent-postgres-init"; };
          subjects = [{ kind = "ServiceAccount"; name = "agent-postgres-init"; namespace = ns; }];
        };

        # The Nix attr name stays fixed; metadata.name is the hashed one.
        jobs.agent-postgres-init = {
          metadata = {
            name = initJobName;
            namespace = ns;
            labels = initJobLabels;
            annotations."agent-sandbox/provisions" = lib.concatStringsSep "," secretNames;
          };
          spec = initJobSpec;
        };
      })

      # -- The in-cluster Postgres server (skipped when external) --------------------
      (lib.mkIf inCluster {
        # RBAC for the initContainer on the Postgres pod that generates the
        # agent-pg-admin superuser secret.
        serviceAccounts.agent-pg-admin-init = {
          metadata = { name = "agent-pg-admin-init"; namespace = ns; };
        };
        roles.agent-pg-admin-init = {
          metadata = { name = "agent-pg-admin-init"; namespace = ns; };
          rules = [{ apiGroups = [ "" ]; resources = [ "secrets" ]; verbs = [ "get" "create" ]; }];
        };
        roleBindings.agent-pg-admin-init = {
          metadata = { name = "agent-pg-admin-init"; namespace = ns; };
          roleRef = { apiGroup = "rbac.authorization.k8s.io"; kind = "Role"; name = "agent-pg-admin-init"; };
          subjects = [{ kind = "ServiceAccount"; name = "agent-pg-admin-init"; namespace = ns; }];
        };
        persistentVolumeClaims.agent-shared-db = {
          metadata = { name = "agent-shared-db"; namespace = ns; };
          spec = {
            accessModes = [ "ReadWriteOnce" ];
            resources.requests.storage = pcfg.storage;
          } // lib.optionalAttrs (pcfg.storageClass != null) {
            storageClassName = pcfg.storageClass;
          };
        };

        deployments.agent-shared-db = {
          metadata = { name = "agent-shared-db"; namespace = ns; };
          spec = {
            replicas = 1;
            strategy.type = "Recreate"; # the old pod must release the RWO PVC first
            selector.matchLabels.app = "agent-shared-db";
            template = {
              metadata.labels.app = "agent-shared-db";
              spec = {
                serviceAccountName = "agent-pg-admin-init";
                # Creates the superuser secret before postgres starts, so the
                # POSTGRES_PASSWORD secretKeyRef always resolves.
                initContainers = [{
                  name = "ensure-admin-secret";
                  image = pcfg.kubectlImage;
                  command = [ "/bin/sh" "-c" ''
                    set -eu
                    if kubectl -n "${ns}" get secret agent-pg-admin >/dev/null 2>&1; then
                      echo "agent-pg-admin exists — reusing"; exit 0
                    fi
                    PW=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)
                    kubectl -n "${ns}" create secret generic agent-pg-admin --from-literal=password="$PW"
                    echo "created agent-pg-admin"
                  '' ];
                }];
                containers.postgres = {
                  name = "postgres";
                  image = pcfg.image;
                  args = [
                    "-c" "max_connections=${toString pcfg.maxConnections}"
                    # Per-query stats, for finding the expensive ones.
                    "-c" "shared_preload_libraries=pg_stat_statements"
                    "-c" "pg_stat_statements.track=all"
                  ];
                  resources = lib.mkDefault {
                    requests = { cpu = "100m"; memory = "512Mi"; };
                    limits = { memory = "1Gi"; };
                  };
                  ports = [{ containerPort = 5432; name = "pg"; }];
                  env = [
                    # A neutral bootstrap db and superuser; consumer dbs come from the Job.
                    { name = "POSTGRES_DB"; value = "postgres"; }
                    { name = "POSTGRES_USER"; value = "postgres"; }
                    { name = "POSTGRES_PASSWORD"; valueFrom.secretKeyRef = { name = "agent-pg-admin"; key = "password"; }; }
                    { name = "PGDATA"; value = "/var/lib/postgresql/data/pgdata"; }
                  ];
                  volumeMounts = [{ name = "data"; mountPath = "/var/lib/postgresql/data"; }];
                  # Polls fast so readiness tracks the database rather than the
                  # probe schedule; everything downstream waits on it.
                  readinessProbe = {
                    exec.command = [ "pg_isready" "-U" "postgres" "-d" "postgres" ];
                    timeoutSeconds = 5; initialDelaySeconds = 2; periodSeconds = 2;
                  };
                  # Liveness stays conservative because a restart mid-initdb on a
                  # cold volume turns a slow start into a crash loop.
                  livenessProbe = {
                    exec.command = [ "pg_isready" "-U" "postgres" "-d" "postgres" ];
                    timeoutSeconds = 5; initialDelaySeconds = 15; periodSeconds = 5; failureThreshold = 6;
                  };
                };
                volumes = [{ name = "data"; persistentVolumeClaim.claimName = "agent-shared-db"; }];
              };
            };
          };
        };

        services.agent-shared-db = {
          metadata = { name = "agent-shared-db"; namespace = ns; };
          spec = {
            selector.app = "agent-shared-db";
            ports = [{ port = 5432; targetPort = "pg"; name = "pg"; }];
          };
        };
      })
    ];
  };
}
