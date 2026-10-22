{ pkgs, lib, n2c, contribSqlDirs ? { }, ... }:

# OCI image for the shared-database migration Job (modules/db-migrate.nix): the
# Atlas CLI, the migrations from lib/sql plus each shipped contrib's own `sql/`,
# and a driver that applies them to each database, adopting a pre-Atlas baseline
# where needed. Safe to run every deploy.

let
  # The migration payload: lib/sql's per-database dirs, plus each contrib database
  # at $out/<db> so the driver sees one directory per env either way.
  sqlPayload = pkgs.runCommandNoCC "scooter-sql" { } (''
    mkdir -p "$out"
    cp -r ${../../lib/sql}/. "$out/"
  '' + lib.concatStrings (lib.mapAttrsToList (db: dir: ''
    if [ -e "$out/${db}" ]; then echo "contrib database ${db} collides with lib/sql/${db}" >&2; exit 1; fi
    mkdir -p "$out/${db}"
    cp -r ${dir}/. "$out/${db}/"
  '') contribSqlDirs));

  runScript = pkgs.writeShellApplication {
    name = "agent-db-migrate";
    # apply_env greps for "not clean".
    runtimeInputs = [ pkgs.atlas pkgs.coreutils pkgs.gnugrep pkgs.postgresql_16 ];
    text = ''
      # SQL_DIR defaults to the baked migrations; overridable for local runs.
      SQL_DIR="''${SQL_DIR:-${sqlPayload}}"
      : "''${DB_HOST:?DB_HOST required}" "''${DB_PORT:?DB_PORT required}" "''${DB_ENVS:?DB_ENVS required}"
      SSL="''${DB_SSLMODE:-disable}"

      # Plain apply handles a fresh or Atlas-managed DB; a pre-Atlas DB reports "not
      # clean" and is re-applied with --baseline, and any other failure is surfaced
      # so the caller retries.
      apply_env() {
        local dir="$1" url="$2" ver="$3" out
        if out="$(atlas migrate apply --dir "$dir" --url "$url" 2>&1)"; then
          printf '%s\n' "$out" | tail -1
          return 0
        fi
        if [ -n "$ver" ] && printf '%s' "$out" | grep -q "not clean"; then
          atlas migrate apply --dir "$dir" --url "$url" --baseline "$ver"
          return $?
        fi
        printf '%s\n' "$out" >&2
        return 1
      }

      # One-time row copies (DB_COPIES = "<db>:<table>:<from> ..."), for a table that
      # moved into a database of its own. Skipped once any of the source's rows is
      # already in the target (matched on the primary key), so a re-run is a no-op.
      # Rows the new service wrote before this ran do not block the copy; the INSERT
      # skips conflicts instead.
      copy_table() {
        local db="$1" table="$2" from="$3" user="$4" pw="$5" cols pk src
        export PGHOST="$DB_HOST" PGPORT="$DB_PORT" PGUSER="$user" PGPASSWORD="$pw" PGSSLMODE="$SSL"
        # Fail on an unreachable database rather than read it as "no table".
        src="$(psql -d "$from" -v ON_ERROR_STOP=1 -tAc "SELECT to_regclass('public.\"$table\"') IS NOT NULL")" || return 1
        if [ "$src" != "t" ]; then
          echo "[$db.$table] no $from.$table — nothing to copy"
          return 0
        fi
        cols="$(psql -d "$db" -tAc "SELECT string_agg(quote_ident(attname), ',' ORDER BY attnum) FROM pg_attribute WHERE attrelid = 'public.\"$table\"'::regclass AND attnum > 0 AND NOT attisdropped")"
        pk="$(psql -d "$db" -tAc "SELECT string_agg(quote_ident(a.attname), ',') FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = 'public.\"$table\"'::regclass AND i.indisprimary")"
        if [ -z "$pk" ]; then
          echo "[$db.$table] has no primary key — refusing to copy (a re-run could not tell copied rows apart)" >&2
          return 1
        fi
        psql -d "$from" -v ON_ERROR_STOP=1 -c "\\copy (SELECT $cols FROM public.\"$table\") TO STDOUT" \
          | psql -d "$db" -v ON_ERROR_STOP=1 -q \
              -c "CREATE TEMP TABLE _src AS SELECT $cols FROM public.\"$table\" WITH NO DATA" \
              -c "\\copy _src ($cols) FROM PSTDIN" \
              -c "DO \$\$ DECLARE n bigint; BEGIN
                    IF EXISTS (SELECT 1 FROM public.\"$table\" JOIN _src USING ($pk)) THEN
                      RAISE NOTICE 'already copied — skipping';
                    ELSE
                      INSERT INTO public.\"$table\" ($cols) SELECT $cols FROM _src ON CONFLICT DO NOTHING;
                      GET DIAGNOSTICS n = ROW_COUNT;
                      RAISE NOTICE 'copied % row(s)', n;
                    END IF;
                  END \$\$"
        echo "[$db.$table] copy from $from done"
      }

      # Retiring a copied table (DB_RETIRE_COPIED=1, scooter.dbMigrate.retireCopiedTables):
      # drop the copy's source table once every one of its primary keys is in the
      # target. A missing row fails the job instead, so nothing is lost silently.
      # Nothing writes the source after release N, so the check cannot race a writer.
      retire_table() {
        local db="$1" table="$2" from="$3" user="$4" pw="$5" pk join missing src
        export PGHOST="$DB_HOST" PGPORT="$DB_PORT" PGUSER="$user" PGPASSWORD="$pw" PGSSLMODE="$SSL"
        # Fail on an unreachable database rather than read it as "no table".
        src="$(psql -d "$from" -v ON_ERROR_STOP=1 -tAc "SELECT to_regclass('public.\"$table\"') IS NOT NULL")" || return 1
        if [ "$src" != "t" ]; then
          echo "[$from.$table] already retired"
          return 0
        fi
        pk="$(psql -d "$db" -tAc "SELECT string_agg(quote_ident(a.attname), ',') FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = 'public.\"$table\"'::regclass AND i.indisprimary")"
        if [ -z "$pk" ]; then
          echo "[$db.$table] has no primary key — refusing to retire $from.$table" >&2
          return 1
        fi
        # Match on every key column: t.a = s.a AND t.b = s.b ...
        join="$(printf '%s' "$pk" | tr ',' '\n' | while read -r c; do printf 't.%s = s.%s AND ' "$c" "$c"; done)"
        join="''${join% AND }"
        missing="$(psql -d "$from" -v ON_ERROR_STOP=1 -c "\\copy (SELECT $pk FROM public.\"$table\") TO STDOUT" \
          | psql -d "$db" -v ON_ERROR_STOP=1 -qtA \
              -c "CREATE TEMP TABLE _src AS SELECT $pk FROM public.\"$table\" WITH NO DATA" \
              -c "\\copy _src ($pk) FROM PSTDIN" \
              -c "SELECT count(*) FROM _src s WHERE NOT EXISTS (SELECT 1 FROM public.\"$table\" t WHERE $join)")" || return 1
        if [ "$missing" != "0" ]; then
          echo "[$from.$table] $missing row(s) are not in $db.$table — refusing to drop it" >&2
          return 1
        fi
        psql -d "$from" -v ON_ERROR_STOP=1 -qc "DROP TABLE IF EXISTS public.\"$table\""
        echo "[$from.$table] every row is in $db.$table — dropped"
      }

      # Each token is <db>[:<role>]; the role defaults to the db's own name (a core
      # service's database) and its password arrives as <ROLE>_DB_PASSWORD.
      declare -A role_of=()
      for spec in $DB_ENVS; do
        env="''${spec%%:*}"; user="''${spec#*:}"
        role_of[$env]="$user"
        pwvar="$(printf '%s' "$user" | tr '[:lower:]-' '[:upper:]_')_DB_PASSWORD"
        pw="''${!pwvar:?missing $pwvar}"
        baseline_file=""
        for f in "$SQL_DIR/$env/migrations"/*_baseline.sql; do
          [ -e "$f" ] && baseline_file="$f" && break
        done
        # No baseline just means nothing to adopt; only an empty dir is skipped.
        any_migration=""
        for f in "$SQL_DIR/$env/migrations"/*.sql; do
          [ -e "$f" ] && any_migration="$f" && break
        done
        if [ -z "$any_migration" ]; then
          echo "[$env] no migrations found — skipping"
          continue
        fi
        baseline_version=""
        if [ -n "$baseline_file" ]; then
          baseline_version="$(basename "$baseline_file")"; baseline_version="''${baseline_version%%_*}"
        else
          echo "[$env] no baseline — applying migrations directly (repo-created database)"
        fi
        dir="file://$SQL_DIR/$env/migrations"
        url="postgres://$user:$pw@$DB_HOST:$DB_PORT/$env?sslmode=$SSL"
        echo "[$env] applying migrations"
        # Retry, since the agent-postgres-init Job that creates the database and role
        # has no ordering guarantee relative to this one.
        n=0
        until apply_env "$dir" "$url" "$baseline_version"; do
          n=$((n + 1))
          if [ "$n" -ge 30 ]; then
            echo "[$env] still failing after $n attempts — giving up"
            exit 1
          fi
          echo "[$env] not ready (attempt $n) — retrying in 5s"
          sleep 5
        done
      done
      for c in ''${DB_COPIES:-}; do
        IFS=: read -r cdb ctable cfrom <<<"$c"
        cuser="''${role_of[$cdb]:?$cdb is not in DB_ENVS}"
        pwvar="$(printf '%s' "$cuser" | tr '[:lower:]-' '[:upper:]_')_DB_PASSWORD"
        copy_table "$cdb" "$ctable" "$cfrom" "$cuser" "''${!pwvar}"
        if [ "''${DB_RETIRE_COPIED:-}" = 1 ]; then
          retire_table "$cdb" "$ctable" "$cfrom" "$cuser" "''${!pwvar}"
        fi
      done
      echo "all migrations applied"
    '';
  };
  image = n2c.buildImage {
    name = "agent-db-migrator";
    tag = "latest";
    copyToRoot = pkgs.buildEnv {
      name = "db-migrator-root";
      paths = [ runScript pkgs.atlas pkgs.bashInteractive pkgs.coreutils pkgs.cacert ];
      pathsToLink = [ "/bin" "/etc/ssl" ];
    };
    config = {
      Entrypoint = [ "${runScript}/bin/agent-db-migrate" ];
      Env = [ "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt" ];
    };
  };
in
# A kubenix module: this image declares its own scooter.images entry.
{
  config.scooter.images.agent-db-migrator = {
    package = lib.mkDefault image;
    attr = "db-migrator-image";
    refKey = "dbMigrator";
  };
}
