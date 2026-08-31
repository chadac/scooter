{ pkgs, lib, n2c, ... }:

# OCI image for the shared-database migration Job (modules/db-migrate.nix).
#
# Bakes the Atlas CLI + the migrations from lib/sql and a small driver script that
# runs `atlas migrate apply --baseline <baseline>` against each per-service
# database. `--baseline` adopts the tables production already has (created by the
# services) on the first deploy without re-executing the baseline, then applies any
# later migrations; the same command is safe to run every deploy. The script needs
# NO dev database — `migrate apply` replays the reviewed migrations directly.

let
  # The reviewed migration payload (all envs' schema.sql + migrations/), copied into
  # the store so the image carries exactly what is committed under lib/sql.
  sqlPayload = pkgs.runCommandNoCC "scooter-sql" { } ''
    mkdir -p "$out"
    cp -r ${../../lib/sql}/. "$out/"
  '';

  runScript = pkgs.writeShellApplication {
    name = "agent-db-migrate";
    # gnugrep is REQUIRED: apply_env greps for "not clean". Why: PR #420.
    runtimeInputs = [ pkgs.atlas pkgs.coreutils pkgs.gnugrep ];
    text = ''
      # SQL_DIR defaults to the baked migrations; overridable for local runs.
      SQL_DIR="''${SQL_DIR:-${sqlPayload}}"
      : "''${DB_HOST:?DB_HOST required}" "''${DB_PORT:?DB_PORT required}" "''${DB_ENVS:?DB_ENVS required}"
      SSL="''${DB_SSLMODE:-disable}"

      # Apply a database's migrations, adopting a pre-Atlas baseline only when needed:
      #   - fresh DB (no tables)      -> plain apply runs the baseline (creates tables)
      #   - Atlas-managed DB          -> plain apply runs only pending migrations
      #   - existing pre-Atlas DB     -> plain apply reports "not clean"; re-apply with
      #                                  --baseline to adopt the tables the services
      #                                  already created without re-running the baseline
      # Any OTHER failure (DB/role not ready) is surfaced so the caller retries.
      apply_env() {
        local dir="$1" url="$2" ver="$3" out
        if out="$(atlas migrate apply --dir "$dir" --url "$url" 2>&1)"; then
          printf '%s\n' "$out" | tail -1
          return 0
        fi
        if printf '%s' "$out" | grep -q "not clean"; then
          atlas migrate apply --dir "$dir" --url "$url" --baseline "$ver"
          return $?
        fi
        printf '%s\n' "$out" >&2
        return 1
      }

      # Each env's database + role share the env's name (see modules/postgres.nix
      # consumers). The per-env password arrives as <ENV>_DB_PASSWORD.
      for env in $DB_ENVS; do
        pwvar="$(printf '%s' "$env" | tr '[:lower:]-' '[:upper:]_')_DB_PASSWORD"
        pw="''${!pwvar:?missing $pwvar}"
        baseline_file=""
        for f in "$SQL_DIR/$env/migrations"/*_baseline.sql; do
          [ -e "$f" ] && baseline_file="$f" && break
        done
        if [ -z "$baseline_file" ]; then
          echo "[$env] no baseline migration found — skipping"
          continue
        fi
        baseline_version="$(basename "$baseline_file")"; baseline_version="''${baseline_version%%_*}"
        dir="file://$SQL_DIR/$env/migrations"
        url="postgres://$env:$pw@$DB_HOST:$DB_PORT/$env?sslmode=$SSL"
        echo "[$env] applying migrations"
        # Retry so the Job tolerates postgres/db/role not being ready yet (the
        # per-consumer database + role are created by the agent-postgres-init Job,
        # which has no ordering guarantee relative to this one).
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
      echo "all migrations applied"
    '';
  };
in
{
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
}
