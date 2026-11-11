# Schema gate: a `wait-for-schema` initContainer for every service that reads
# Postgres, so a release's pods start only once agent-db-migrate has applied that
# release's migrations to each database the service reads.
#
# It checks the database, not the migrate Job: the Job is TTL-reaped after a day,
# and a pod rescheduled after that must still start. The expected version per
# database is the newest migration file in the same directories the migrator image
# bakes in, so the gate and the migrator cannot disagree.

{ config, lib, ... }:

let
  cfg = config.scooter;
  pcfg = cfg.postgres;
  inherit (lib) mkOption types;

  # Databases the migrate Job applies.
  provisioned = lib.mapAttrsToList (_: c: c.db) pcfg.consumers ++ lib.attrNames pcfg.databases;
  migrated = lib.filter (db: builtins.elem db provisioned) cfg.dbSpec.databases;

  # The migrations the migrator image bundles for a database.
  contribSrcOf = db: lib.findFirst (c: c.db.enable && c.db.name == db) null (lib.attrValues config.contribs);
  migrationsDir = db:
    if cfg.db.${db}.sqlDir == null then ../lib/sql + "/${db}/migrations"
    else let c = contribSrcOf db; in
      if c == null then throw "scooter.db.${db}: no contrib provides its sqlDir ${cfg.db.${db}.sqlDir}"
      else c.src + "/sql/migrations";

  # The newest migration's version (its timestamp prefix), or null with none.
  expectedVersion = db:
    let
      dir = migrationsDir db;
      files = lib.attrNames (lib.filterAttrs (n: t: t == "regular" && lib.hasSuffix ".sql" n)
        (if builtins.pathExists dir then builtins.readDir dir else { }));
      versions = map (n: builtins.head (lib.splitString "_" n)) files;
    in
    if versions == [ ] then null else lib.last (lib.sort (a: b: a < b) versions);

  # Role keys, as in each agent-pg-<key> Secret.
  roleKeys = lib.attrNames pcfg.consumers ++ lib.attrNames pcfg.readers;
  roleOf = key: pcfg.consumers.${key}.user or pcfg.readers.${key}.user;

  # Databases a role owns or is granted.
  databasesOf = key: lib.unique (lib.filter (db: cfg.schemaGate.versions ? ${db})
    (lib.optional (pcfg.consumers ? ${key}) pcfg.consumers.${key}.db
      ++ lib.attrNames (lib.filterAttrs (_: d: d.owner == key) pcfg.databases)
      ++ map (g: g.db) (pcfg.readers.${key}.grants or [ ])
      ++ map (g: g.db) (pcfg.grants.${key} or [ ])));

  # schemaGate.ts's query; a newer schema passes too.
  gateScript = key: dbs:
    let user = roleOf key; in ''
      set -u
    '' + lib.optionalString (pcfg.directSslmode != null) ''
      export PGSSLMODE="${pcfg.directSslmode}"
    '' + lib.concatMapStrings (db:
      let v = cfg.schemaGate.versions.${db}; in ''
        echo "[${db}] waiting for schema version ${v} ..."
        n=0
        until [ "$(psql -h "${pcfg.directHost}" -p "${toString pcfg.directPort}" -U "${user}" -d "${db}" -tAc \
          "SELECT coalesce(max(version) >= '${v}', false) FROM atlas_schema_revisions.atlas_schema_revisions WHERE applied >= total" \
          2>/dev/null)" = "t" ]; do
          n=$((n + 1))
          # No deadline: a pod stuck in Init points at the agent-db-migrate Job.
          [ $((n % 15)) -eq 0 ] && echo "[${db}] still below ${v} after ~$((n * 2))s; is agent-db-migrate running?"
          sleep 2
        done
        echo "[${db}] at or past ${v}"
      '') dbs;

  initContainersOf = key:
    let dbs = databasesOf key; in
    lib.optional (cfg.dbMigrate.enable && dbs != [ ]) {
      name = "wait-for-schema";
      # The postgres image carries psql.
      image = pcfg.image;
      command = [ "/bin/sh" "-c" (gateScript key dbs) ];
      env = [{ name = "PGPASSWORD"; valueFrom.secretKeyRef = { name = "agent-pg-${key}"; key = "password"; }; }];
      resources = {
        requests = { cpu = "10m"; memory = "16Mi"; };
        limits.memory = "64Mi";
      };
    };
in
{
  options.scooter.schemaGate = {
    versions = mkOption {
      internal = true;
      readOnly = true;
      type = types.attrsOf types.str;
      default = lib.genAttrs (lib.filter (db: expectedVersion db != null) migrated) expectedVersion;
      description = "Per migrated database, the migration version this release expects.";
    };
    initContainers = mkOption {
      internal = true;
      readOnly = true;
      type = types.attrsOf (types.listOf types.attrs);
      default = lib.genAttrs roleKeys initContainersOf;
      description = ''
        Per postgres role key (a `consumers` or `readers` key), the `wait-for-schema`
        initContainer for its Deployment, or none when it reads no migrated database.
      '';
    };
  };
}
