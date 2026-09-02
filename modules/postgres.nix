# Shared Postgres — the platform's durable store, ALWAYS on.
#
# Multiple services persist to Postgres now (webhooks conversation-map, scheduler
# tasks, the AWS broker's permission/size store, optionally OpenFGA), so a shared
# `agent-shared-db` is an essential dependency — not a webhooks add-on. This module
# owns it.
#
# Two modes:
#   - IN-CLUSTER (default): a single-replica Postgres pod backed by a PVC, plus a
#     Service `agent-shared-db`. Hosts multiple logical databases, one per consumer.
#   - EXTERNAL (RDS etc.): set `external.host` and it SKIPS the pod/PVC/Service; the
#     consumers point at that host instead. The only thing this module still emits is
#     the per-consumer provisioning Job (it runs against the external server too).
#
# Per-consumer isolation (least privilege): each consumer gets its OWN database and
# its OWN role that OWNS only that database. Passwords are AUTO-GENERATED in-cluster
# by the init Job and written to per-consumer Secrets (`agent-pg-<consumer>`, key
# `password`) — never committed, never hand-managed. Consumers read their own secret.
#
# The consumer set is assembled by platform.nix from which features are enabled and
# fed in via `agentSandbox.postgres.consumers`. Each entry: { db; user; }.

{ config, lib, ... }:

let
  cfg = config.agentSandbox;
  pcfg = cfg.postgres;
  ns = cfg.namespace;

  inCluster = pcfg.external == null;
  # The server host consumers connect to: the in-cluster Service, or the external one.
  host = if inCluster then "agent-shared-db.${ns}.svc.cluster.local" else pcfg.external.host;
  port = if inCluster then 5432 else pcfg.external.port;

  # The ADMIN (superuser) credentials the init Job uses to CREATE ROLE/DATABASE.
  #  - in-cluster: the postgres superuser we bootstrap (POSTGRES_USER/PASSWORD), whose
  #    password is auto-generated into `agent-pg-admin`.
  #  - external: the deployer supplies external.passwordSecret + external.user (an RDS
  #    master user with CREATEDB/CREATEROLE).
  adminUser = if inCluster then "postgres" else pcfg.external.user;
  adminSecret =
    if inCluster
    then { name = "agent-pg-admin"; key = "password"; }
    else { inherit (pcfg.external.passwordSecret) name key; };

  consumers = pcfg.consumers;
  consumerNames = builtins.attrNames consumers;

  # READERS are login roles granted SELECT-only on ANOTHER consumer's database (they own no
  # database of their own). Each gets an agent-pg-<key> secret like a consumer, but instead of
  # CREATE DATABASE it gets CONNECT + USAGE + SELECT on `db` and is pinned read-only at the
  # server. Assembled by platform.nix (e.g. the conversation-router reading agent_host).
  readers = pcfg.readers;
  readerNames = builtins.attrNames readers;
  # Both consumers and readers need a generated password secret.
  secretNames = consumerNames ++ readerNames;

  # No single common image ships BOTH kubectl and psql, so the provisioning Job is
  # two containers sharing an emptyDir (/shared):
  #   1. initContainer `secrets` (kubectl image): for each consumer, reuse an existing
  #      agent-pg-<name> Secret or generate one, and write the password to
  #      /shared/<name>.pw. Re-runnable — an existing secret is never rotated.
  #   2. container `sql` (postgres image, has psql/pg_isready): read /shared/<name>.pw
  #      and idempotently CREATE ROLE + CREATE DATABASE (owned by the role).

  # -- initContainer: kubectl only (create/reuse the per-consumer secrets) ----------
  secretsScript = ''
    set -eu
    mkdir -p /shared
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
  '' + lib.concatMapStrings (name:
    let c = consumers.${name}; in ''
    # ---- consumer ${name}: db=${c.db} user=${c.user} ----
    PW=$(cat "/shared/${name}.pw")
    # Idempotent role: create if missing, else (re)set its password to the secret's.
    psql -v ON_ERROR_STOP=1 -v pw="$PW" <<'SQL'
    SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', '${c.user}', :'pw')
      WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${c.user}') \gexec
    SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', '${c.user}', :'pw')
      WHERE EXISTS (SELECT FROM pg_roles WHERE rolname = '${c.user}') \gexec
    SQL
    # Idempotent database owned by the role (CREATE DATABASE can't run in a txn/DO,
    # so gate it with a shell check).
    if [ "$(psql -tAc "SELECT 1 FROM pg_database WHERE datname='${c.db}'")" != "1" ]; then
      psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE "${c.db}" OWNER "${c.user}"'
      echo "[${name}] created database ${c.db}"
    fi
  '') consumerNames
  # READERS come AFTER consumers: a reader grants on a database the consumer loop above just
  # created, so the db + its owner role must already exist here.
  + lib.concatMapStrings (name:
    let r = readers.${name}; in ''
    # ---- reader ${name}: role=${r.user} SELECT-only on ${toString (builtins.length r.grants)} db(s) ----
    PW=$(cat "/shared/${name}.pw")
    # Idempotent LOGIN role, same create-or-reset-password shape as a consumer.
    psql -v ON_ERROR_STOP=1 -v pw="$PW" <<'SQL'
    SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', '${r.user}', :'pw')
      WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${r.user}') \gexec
    SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', '${r.user}', :'pw')
      WHERE EXISTS (SELECT FROM pg_roles WHERE rolname = '${r.user}') \gexec
    SQL
    # Read-only at the SERVER: this role can never begin a writing transaction, whatever it
    # attempts — the load-bearing half of the guarantee (the client sets the same param too).
    psql -v ON_ERROR_STOP=1 -c 'ALTER ROLE "${r.user}" SET default_transaction_read_only = on'
  '' + lib.concatMapStrings (g: ''
    # Least privilege on ${g.db}: CONNECT + USAGE + SELECT existing tables, and — via DEFAULT
    # PRIVILEGES on the OWNER — SELECT any table the owner creates later (migrations), so a new
    # table never silently becomes unreadable. No INSERT/UPDATE/DELETE ever granted.
    # (ALTER DEFAULT PRIVILEGES FOR ROLE needs the admin to be that role's member; the
    # in-cluster admin is the superuser, which always is.)
    psql -v ON_ERROR_STOP=1 -c 'GRANT CONNECT ON DATABASE "${g.db}" TO "${r.user}"'
    psql -v ON_ERROR_STOP=1 -d "${g.db}" -c 'GRANT USAGE ON SCHEMA public TO "${r.user}"'
    psql -v ON_ERROR_STOP=1 -d "${g.db}" -c 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${r.user}"'
    psql -v ON_ERROR_STOP=1 -d "${g.db}" -c 'ALTER DEFAULT PRIVILEGES FOR ROLE "${g.owner}" IN SCHEMA public GRANT SELECT ON TABLES TO "${r.user}"'
    echo "[${name}] granted SELECT-only on ${g.db} to ${r.user}"
  '') r.grants) readerNames;
in
{
  options.agentSandbox.postgres = with lib; {
    image = mkOption {
      type = types.str;
      default = "postgres:16-alpine";
      description = "Postgres image for the in-cluster server (ignored when `external` is set).";
    };
    kubectlImage = mkOption {
      type = types.str;
      # Needs kubectl AND a shell + coreutils (sh/tr/base64/head) — so NOT the
      # distroless registry.k8s.io/kubectl (kubectl binary only) and NOT bitnami/
      # kubectl (public tags retired in 2025). alpine/k8s bundles all of it.
      default = "alpine/k8s:1.30.0";
      description = "Image for the provisioning Job's secret-creating initContainer (needs kubectl + a shell + coreutils).";
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
    # Populated by platform.nix from the enabled features — NOT set by deployers.
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
    # READ-ONLY roles granted SELECT on another consumer's database. Populated by platform.nix.
    readers = mkOption {
      internal = true;
      default = { };
      description = ''
        Per-reader { user; grants = [ { db; owner; } … ]; } map — a SELECT-only login role
        granted on one or more existing consumer databases (`db`, owned by `owner`). Assembled
        by platform.nix, not by deployers. The role owns nothing, is pinned
        default_transaction_read_only, and reuses a single agent-pg-<key> secret across all its
        grants (one role, one password, many read grants).
      '';
      type = types.attrsOf (types.submodule {
        options = {
          user = mkOption { type = types.str; description = "The read-only login role name."; };
          grants = mkOption {
            description = "Databases this role may SELECT from.";
            type = types.listOf (types.submodule {
              options = {
                db = mkOption { type = types.str; description = "The database to grant SELECT on."; };
                owner = mkOption { type = types.str; description = "The role that owns `db`'s tables (for DEFAULT PRIVILEGES)."; };
              };
            });
          };
        };
      });
    };
    # Read-only outputs other modules consume (so they don't re-derive the host).
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
        # The Job creates per-consumer Secrets → needs create/get on secrets.
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

        jobs.agent-postgres-init = {
          metadata = {
            name = "agent-postgres-init";
            namespace = ns;
            annotations."agent-sandbox/provisions" = lib.concatStringsSep "," secretNames;
          };
          spec = {
            backoffLimit = 6;
            template.spec = {
              serviceAccountName = "agent-postgres-init";
              restartPolicy = "OnFailure";
              # 1) kubectl: create/reuse the per-consumer secrets, drop the passwords
              #    onto a shared emptyDir for the psql step to read.
              initContainers = [{
                name = "secrets";
                image = pcfg.kubectlImage;
                command = [ "/bin/sh" "-c" secretsScript ];
                volumeMounts = [{ name = "shared"; mountPath = "/shared"; }];
              }];
              # 2) psql (postgres image has the client): create roles + databases.
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
      })

      # -- The in-cluster Postgres server (skipped when external) --------------------
      (lib.mkIf inCluster {
        # Auto-generate the superuser password into agent-pg-admin the FIRST time (a
        # tiny Job); if it already exists it's reused. The Postgres pod reads it.
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
        jobs.agent-pg-admin-init = {
          metadata = { name = "agent-pg-admin-init"; namespace = ns; };
          spec = {
            backoffLimit = 4;
            template.spec = {
              serviceAccountName = "agent-pg-admin-init";
              restartPolicy = "OnFailure";
              containers.gen = {
                name = "gen";
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
              };
            };
          };
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
            strategy.type = "Recreate"; # single RWO PVC — old pod must release it first
            selector.matchLabels.app = "agent-shared-db";
            template = {
              metadata.labels.app = "agent-shared-db";
              spec = {
                containers.postgres = {
                  name = "postgres";
                  image = pcfg.image;
                  resources = lib.mkDefault {
                    requests = { cpu = "100m"; memory = "512Mi"; };
                    limits = { memory = "1Gi"; };
                  };
                  ports = [{ containerPort = 5432; name = "pg"; }];
                  env = [
                    # A neutral bootstrap db/user; per-consumer dbs are created by the
                    # provisioning Job. The superuser is `postgres` with the generated pw.
                    { name = "POSTGRES_DB"; value = "postgres"; }
                    { name = "POSTGRES_USER"; value = "postgres"; }
                    { name = "POSTGRES_PASSWORD"; valueFrom.secretKeyRef = { name = "agent-pg-admin"; key = "password"; }; }
                    { name = "PGDATA"; value = "/var/lib/postgresql/data/pgdata"; }
                  ];
                  volumeMounts = [{ name = "data"; mountPath = "/var/lib/postgresql/data"; }];
                  readinessProbe = {
                    exec.command = [ "pg_isready" "-U" "postgres" "-d" "postgres" ];
                    timeoutSeconds = 5; initialDelaySeconds = 10; periodSeconds = 10;
                  };
                  livenessProbe = {
                    exec.command = [ "pg_isready" "-U" "postgres" "-d" "postgres" ];
                    timeoutSeconds = 5; initialDelaySeconds = 15; periodSeconds = 10; failureThreshold = 6;
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
