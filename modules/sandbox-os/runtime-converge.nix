# programs.scooterModule: re-converge the running sandbox at runtime via
# switch-to-configuration, rebuilding its own toplevel from the base config plus
# any mounted, local or registry modules. The image ships the base-config builder
# (runtime-converge/base-config.nix), the pinned nixpkgs and the vendored
# modules/sandbox-os source as store paths so the in-pod build is offline, and the
# scooter-apply-module / scooter-env-status / scooter-rebuild tools.

{ config, lib, pkgs, nixStubs, ... }:

let
  cfg = config.programs.scooterModule;

  # agent-broker, the authenticated broker curl wrapper scooter-rebuild's registry
  # subcommands use.
  brokerTools = pkgs.callPackage ../../pkgs/broker-tools { };

  # The base-config entrypoint and vendored modules tree, shared with the nixosTest
  # so it pre-builds the re-converged toplevel from identical derivations.
  inherit (import ./runtime-converge/reconverge-inputs.nix {
    inherit pkgs lib nixStubs;
    # Only read at image build: in the pod the baked tree is used (effTree below).
    skillDirs = config.scooter.skillDirs;
  })
    baseConfig modulesTree modulesSrc;

  # At image build the tree and modules source are derived; at re-converge
  # base-config sets cfg.modulesTree to the already-baked tree, which must be used
  # everywhere because a re-derived tree hashes differently and is not in the store.
  # `storeRef` re-attaches store context to that bare path (`builtins.storePath` is
  # banned in pure eval, so `appendContext` covers the nixosTest).
  storeRef = p:
    if builtins ? currentSystem then builtins.storePath p
    else builtins.appendContext p { ${p} = { path = true; }; };
  effTree = if cfg.modulesTree != null then storeRef cfg.modulesTree else modulesTree;
  effModulesSrc = if cfg.modulesTree != null then "${storeRef cfg.modulesTree}/modules/sandbox-os" else modulesSrc;

  # Every module a re-converge layers on top of the base config, as one list of
  # store paths a self-modify replays verbatim.
  reconvergeModules = cfg.extraReconvergeModules
    ++ map (f: "${effTree}/${f}") cfg.extraReconvergeModuleFiles;

  # The list as a JSON file in the store, read inside the apply script's `nix build
  # --expr` and surfaced at /etc/scooter/reconverge-modules.json.
  reconvergeModulesFile = pkgs.writeText "scooter-reconverge-modules.json"
    (builtins.toJSON reconvergeModules);

  # The canonical system profile, whose numbered generations are the rollback ladder.
  systemProfile = "/nix/var/nix/profiles/system";

  # Where scooter-apply-module writes its status/error/log for scooter-env-status
  # and the agent-host to read (tmpfs, so a fresh boot has no stale status).
  statusDir = "/run/scooter/env-switch";

  applyModule = pkgs.writeShellApplication {
    name = "scooter-apply-module";
    # systemd provides `systemd-run` for the detached converge, findutils the `find`
    # the local-module probe needs: the detached child inherits systemd's PATH, not
    # the agent shell's, so a tool missing here fails only on the boot path.
    runtimeInputs = [ pkgs.nix pkgs.coreutils pkgs.findutils pkgs.systemd pkgs.gnugrep pkgs.gawk ];
    checkPhase = "";
    text = ''
      # scooter-apply-module [--module <path>] [--detach]: re-converge this sandbox
      # via switch-to-configuration with generation registration and auto-rollback.
      # The in-pod `nix build` is the validation gate, each good build is registered
      # as a system generation, and a switch that introduces new failed units is
      # rolled back to the prior generation. --detach runs the build+switch as a
      # background transient unit and returns immediately, with status and log
      # written to ${statusDir} for scooter-env-status to poll.
      set -euo pipefail

      # The optional extra module; without one the base config alone is rebuilt
      # (it already imports local and registry modules), with the deployment's
      # .scooter module as a fallback only when it exists and is non-empty.
      module=""
      cm_module=${lib.escapeShellArg cfg.dir}/module.nix
      detach=0
      while [ $# -gt 0 ]; do
        case "$1" in
          --module) module="$2"; shift 2 ;;
          --detach) detach=1; shift ;;
          *) echo "scooter-apply-module: unknown arg: $1" >&2; exit 2 ;;
        esac
      done
      # With no explicit --module, fall back to the deployment module if it has content.
      if [ -z "$module" ] && [ -s "$cm_module" ] && [ -n "$(tr -d '[:space:]' < "$cm_module" 2>/dev/null)" ]; then
        module="$cm_module"
      fi

      # --- status/log protocol (read by scooter-env-status) --------------------
      # ${statusDir}/status : one word — building | switching | done | failed | idle
      # ${statusDir}/error  : the failure summary (empty on success)
      # ${statusDir}/log    : the full combined stdout+stderr of the run
      status_dir=${lib.escapeShellArg statusDir}
      write_status() {
        mkdir -p "$status_dir"
        printf '%s\n' "$1" > "$status_dir/status"
        [ $# -ge 2 ] && printf '%s\n' "$2" > "$status_dir/error" || : > "$status_dir/error"
      }

      # --- --detach: re-exec this run in a separate systemd unit, then return ---
      # The child runs as its own transient unit so it lives in a cgroup the switch
      # does not manage (the boot unit is restarted by the switch, which would kill a
      # plain setsid child before it writes `done`); an in-flight switch is refused.
      if [ "$detach" -eq 1 ]; then
        mkdir -p "$status_dir"
        cur=$(cat "$status_dir/status" 2>/dev/null || echo idle)
        if [ "$cur" = "building" ] || [ "$cur" = "switching" ]; then
          echo "scooter-apply-module: a switch is already in progress ($cur) — refusing" >&2
          exit 3
        fi
        write_status building
        # Re-exec the same script without --detach as a transient unit, appending
        # its output to the log file.
        systemd-run --collect --quiet \
          --unit="scooter-env-switch-$$" \
          --property=StandardOutput="append:$status_dir/log" \
          --property=StandardError="append:$status_dir/log" \
          "$0" --module "$module"
        echo "scooter-apply-module: applying in the background — poll scooter-env-status"
        exit 0
      fi

      # The foreground run maintains status too, so a synchronous call reports its phases.
      write_status building

      # Any unexpected exit before the explicit done/failed write marks failed, so a
      # poller never sees a stuck "building" (the detached child's death is otherwise
      # invisible — nothing else ever rewrites the status the parent set).
      trap 'rc=$?; if [ "$rc" -ne 0 ]; then write_status failed "scooter-apply-module exited $rc"; fi' EXIT

      # A missing or empty extra module is dropped (an empty file is not a valid Nix
      # module) and the base config is still re-converged.
      if [ -n "$module" ] && { [ ! -e "$module" ] || [ ! -s "$module" ] || [ -z "$(tr -d '[:space:]' < "$module")" ]; }; then
        echo "scooter-apply-module: extra module $module is missing/empty — re-converging base config only" >&2
        module=""
      fi

      # With no extra module and nothing local or attached for the base to pick up,
      # exit idle without building.
      if [ -z "$module" ]; then
        local_mods=""
        # stderr is kept: a probe that cannot run must not read as "no modules".
        [ -d /etc/scooter/modules ] && local_mods=$(find -L /etc/scooter/modules -maxdepth 1 -name '*.nix' -type f | head -1)
        reg_mods=""
        [ -s /etc/scooter/registry-modules.json ] && reg_mods=$(tr -d '[]" \n\t' < /etc/scooter/registry-modules.json 2>/dev/null)
        if [ -z "$local_mods" ] && [ -z "$reg_mods" ]; then
          echo "scooter-apply-module: no module and nothing to converge — nothing to apply" >&2
          write_status idle
          exit 0
        fi
      fi

      # Wait (bounded, non-fatal) for the overlay store to settle, since a lower-only
      # path such as the baked modules tree reads back as invalid until the upper's
      # state DB commits.
      for _ in $(seq 1 90); do
        if nix-store --realise ${effTree} >/dev/null 2>&1; then break; fi
        sleep 1
      done

      if [ -n "$module" ]; then
        echo "scooter-apply-module: building toplevel (base + $module)..."
        module_expr="$module"
      else
        echo "scooter-apply-module: building toplevel (base config + local/registry modules)..."
        module_expr=""
      fi
      # Build the base config plus the optional extra module (--impure to read the
      # module path and local-modules dir); a build failure exits here, before any
      # profile or switch change. The layer list is read as JSON inside the expr so
      # bash never expands it, and the string context is discarded because fromJSON
      # refuses a string carrying any (the tree is in the closure regardless).
      toplevel=$(nix build --no-link --print-out-paths --impure --expr "
        let layers = builtins.fromJSON (builtins.unsafeDiscardStringContext (builtins.readFile ${reconvergeModulesFile})); in
        (import ${baseConfig} {
          nixpkgs = ${cfg.nixpkgs};
          modulesPath = ${effModulesSrc};
          extraModules =
            # Layer the running system's extra config, then re-declare the list in the
            # system being built so it survives every subsequent switch (base-config.nix
            # force-sets programs.scooterModule.{enable,nixpkgs} itself).
            map (p: /. + p) layers
            ++ [ { programs.scooterModule.extraReconvergeModules = layers; } ]
            ++ [ $module_expr ];
        }).toplevel
      ")

      # The rollback target is the currently running system, not the profile link
      # nix-env --set is about to repoint (empty on the very first apply).
      prev=$(readlink -f /run/current-system 2>/dev/null || readlink -f ${systemProfile} 2>/dev/null || true)

      # Snapshot the already-failed units, since new failures (not the switch's exit
      # code, which is unreliable in a container) are the rollback signal.
      failed_before=$(systemctl list-units --state=failed --plain --no-legend 2>/dev/null | awk '{print $1}' | sort || true)

      # Register the built toplevel as a new system generation, then switch to it.
      echo "scooter-apply-module: registering generation + switching to $toplevel..."
      write_status switching
      nix-env -p ${systemProfile} --set "$toplevel"

      # Run the switch synchronously in a transient scope the switch does not manage
      # (it restarts the boot unit), ignoring its unreliable exit code.
      systemd-run --scope --collect --quiet \
        --unit="scooter-switch-$$" \
        "$toplevel/bin/switch-to-configuration" switch || true

      # Health gate: a unit failed now but not before is the module's doing.
      health_ok=1
      failed_after=$(systemctl list-units --state=failed --plain --no-legend 2>/dev/null | awk '{print $1}' | sort || true)
      new_failures=$(comm -13 <(printf '%s\n' "$failed_before") <(printf '%s\n' "$failed_after") || true)
      if [ -n "$new_failures" ]; then
        echo "scooter-apply-module: switch introduced FAILED units:" >&2
        printf '  %s\n' $new_failures >&2
        health_ok=0
      fi

      if [ "$health_ok" -ne 1 ]; then
        echo "scooter-apply-module: apply FAILED (new failed units after switch)" >&2
        write_status failed "switch introduced failed units: $(printf '%s ' $new_failures)"
        if [ -n "$prev" ]; then
          echo "scooter-apply-module: ROLLING BACK to $prev..." >&2
          # Roll the profile back and re-switch so the sandbox is left in the last-good config.
          nix-env -p ${systemProfile} --rollback || true
          systemd-run --scope --collect --quiet \
            --unit="scooter-rollback-$$" \
            "$prev/bin/switch-to-configuration" switch || \
            echo "scooter-apply-module: rollback switch ALSO failed — manual intervention needed" >&2
        else
          echo "scooter-apply-module: no prior generation to roll back to" >&2
        fi
        exit 1
      fi

      echo "scooter-apply-module: applied."
      write_status done
      trap - EXIT
    '';
  };

  # scooter-env-status prints the async switch status (plus the log on failure) and
  # exits 0 for done/idle, 1 for failed, 2 for in-progress.
  envStatus = pkgs.writeShellApplication {
    name = "scooter-env-status";
    runtimeInputs = [ pkgs.coreutils ];
    text = ''
      # scooter-env-status [--log]   show the env-switch status (+ log on failure)
      set -euo pipefail
      status_dir=${lib.escapeShellArg statusDir}
      show_log=0
      [ "''${1:-}" = "--log" ] && show_log=1
      st=$(cat "$status_dir/status" 2>/dev/null || echo idle)
      case "$st" in
        done|idle)
          echo "environment: $st (ready)"; exit 0 ;;
        building|switching)
          echo "environment: $st — the switch is still in progress; check again shortly."; exit 2 ;;
        failed)
          echo "environment: FAILED" >&2
          err=$(cat "$status_dir/error" 2>/dev/null || true)
          [ -n "$err" ] && echo "reason: $err" >&2
          echo "--- full build/switch log ---" >&2
          cat "$status_dir/log" 2>/dev/null >&2 || echo "(no log)" >&2
          exit 1 ;;
        *)
          echo "environment: $st"; [ "$show_log" -eq 1 ] && cat "$status_dir/log" 2>/dev/null || true; exit 0 ;;
      esac
    '';
  };

  # scooter-rebuild, the agent's nixos-rebuild-like entrypoint: a dispatcher over
  # scooter-apply-module / scooter-env-status, local module editing under
  # /etc/scooter/modules, and the shared broker registry (see `usage` below).
  scooterRebuild = pkgs.writeShellApplication {
    name = "scooter-rebuild";
    runtimeInputs = [ applyModule envStatus pkgs.coreutils pkgs.findutils brokerTools.agent-broker pkgs.jq ];
    text = ''
      set -euo pipefail

      # modules/ is the agent-editable dir local-modules.nix imports, and the
      # registry file is the attach list registry-modules.nix fetches from the broker.
      MODULES_DIR=/etc/scooter/modules
      REGISTRY_IDS_FILE=/etc/scooter/registry-modules.json

      usage() {
        cat >&2 <<'EOF'
      scooter-rebuild — build + switch your sandbox environment.

        scooter-rebuild switch [--detach]   apply the current config (build + switch)
        scooter-rebuild status [--log]      show the switch status (+ log on failure)

      Local modules (yours, authored under /etc/scooter/modules/*.nix):
        scooter-rebuild module list                 list your local modules
        scooter-rebuild module new  <name>          create modules/<name>.nix (template)
        scooter-rebuild module edit <name>          edit modules/<name>.nix ($EDITOR)
        scooter-rebuild module show <name>          print modules/<name>.nix
        scooter-rebuild module rm   <name>          delete modules/<name>.nix

      Shared registry (attach modules others published, publish your own):
        scooter-rebuild module search [query]       search the registry catalog
        scooter-rebuild module add    <name-or-id>  attach a registry module (+ switch)
        scooter-rebuild module detach <name-or-id>  detach an attached registry module
        scooter-rebuild module attached             list your attached registry modules
        scooter-rebuild publish <name> [--public] [--description D]
                                                    publish local modules/<name>.nix to the registry

      Your modules live in /etc/scooter/modules/*.nix (durable on the workspace PVC).
      Edit them, then `scooter-rebuild switch`. A bad module fails the build (no switch).
      EOF
      }

      # Reject a name that is not a plain module basename.
      module_path() {
        local name="$1"
        case "$name" in
          ""|*/*|.|..) echo "scooter-rebuild: invalid module name '$name'" >&2; exit 2 ;;
        esac
        printf '%s/%s.nix' "$MODULES_DIR" "$name"
      }

      cmd="''${1:-}"; shift || true
      case "$cmd" in
        switch)
          # With no --module, scooter-apply-module rebuilds the base config, which
          # imports the local and registry modules.
          exec scooter-apply-module "$@"
          ;;
        status)
          exec scooter-env-status "$@"
          ;;
        module)
          sub="''${1:-}"; shift || true
          case "$sub" in
            list|ls)
              mkdir -p "$MODULES_DIR"
              # -L because MODULES_DIR is a symlink and find will not descend it otherwise.
              found=$(find -L "$MODULES_DIR" -maxdepth 1 -name '*.nix' -printf '%f\n' 2>/dev/null | sed 's/\.nix$//' | sort || true)
              if [ -z "$found" ]; then echo "no modules yet — create one with: scooter-rebuild module new <name>"; else echo "$found"; fi
              ;;
            new)
              name="''${1:-}"; path=$(module_path "$name")
              mkdir -p "$MODULES_DIR"
              if [ -e "$path" ]; then echo "scooter-rebuild: $name already exists (edit it: scooter-rebuild module edit $name)" >&2; exit 1; fi
              cat > "$path" <<'TEMPLATE'
      # A sandbox environment module. This is a NixOS module — declare packages,
      # services, env, etc. Run `scooter-rebuild switch` to apply.
      { pkgs, lib, ... }:
      {
        # environment.systemPackages = [ pkgs.jq ];
      }
      TEMPLATE
              echo "created $path — edit it, then: scooter-rebuild switch"
              ;;
            edit)
              name="''${1:-}"; path=$(module_path "$name")
              mkdir -p "$MODULES_DIR"
              [ -e "$path" ] || scooter-rebuild module new "$name" >/dev/null
              exec "''${EDITOR:-vi}" "$path"
              ;;
            show|cat)
              name="''${1:-}"; path=$(module_path "$name")
              [ -e "$path" ] || { echo "scooter-rebuild: no module '$name'" >&2; exit 1; }
              cat "$path"
              ;;
            rm|delete)
              name="''${1:-}"; path=$(module_path "$name")
              [ -e "$path" ] || { echo "scooter-rebuild: no module '$name'" >&2; exit 1; }
              rm -f "$path"
              echo "removed $name — run: scooter-rebuild switch"
              ;;
            search|find)
              # Query the broker catalog (own private plus all public); no query lists all.
              q="''${1:-}"
              agent-broker "modules?q=$q" | jq -r '
                (.modules // []) as $m
                | if ($m | length) == 0 then "no modules found"
                  else ($m[] | "\(.name)  (#\(.id), \(.visibility))\(if (.description // "") != "" then "  — \(.description)" else "" end)")
                  end'
              ;;
            add|attach)
              # Resolve the ref via the broker so the canonical name is stored (the
              # download endpoint tars under <name>/) and a missing module fails fast.
              ref="''${1:-}"
              [ -n "$ref" ] || { echo "scooter-rebuild module add: <name-or-id> required" >&2; exit 2; }
              name=$(agent-broker "modules/$ref" | jq -er '.name') \
                || { echo "scooter-rebuild: registry module '$ref' not found (or not visible to you)" >&2; exit 1; }
              [ -f "$REGISTRY_IDS_FILE" ] || echo '[]' > "$REGISTRY_IDS_FILE"
              # Idempotent add that keeps the list unique.
              if jq -e --arg n "$name" 'index($n)' "$REGISTRY_IDS_FILE" >/dev/null; then
                echo "$name is already attached"
              else
                tmp=$(mktemp)
                jq --arg n "$name" '. + [$n] | unique' "$REGISTRY_IDS_FILE" > "$tmp" && mv "$tmp" "$REGISTRY_IDS_FILE"
                echo "attached $name — applying..."
                exec scooter-apply-module "''${@:2}"
              fi
              ;;
            detach)
              # Accepts the stored name, or resolves an id to its name so `detach <id>`
              # mirrors `add`.
              ref="''${1:-}"
              [ -n "$ref" ] || { echo "scooter-rebuild module detach: <name-or-id> required" >&2; exit 2; }
              [ -f "$REGISTRY_IDS_FILE" ] || { echo "no attached registry modules"; exit 0; }
              name="$ref"
              if ! jq -e --arg n "$name" 'index($n)' "$REGISTRY_IDS_FILE" >/dev/null 2>&1; then
                # Not a stored name, so ask the broker for the canonical name.
                name=$(agent-broker "modules/$ref" 2>/dev/null | jq -er '.name' 2>/dev/null || echo "$ref")
              fi
              if jq -e --arg n "$name" 'index($n)' "$REGISTRY_IDS_FILE" >/dev/null; then
                tmp=$(mktemp)
                jq --arg n "$name" 'map(select(. != $n))' "$REGISTRY_IDS_FILE" > "$tmp" && mv "$tmp" "$REGISTRY_IDS_FILE"
                echo "detached $name — applying..."
                exec scooter-apply-module "''${@:2}"
              else
                echo "$ref is not attached"
              fi
              ;;
            attached)
              if [ -f "$REGISTRY_IDS_FILE" ] && [ "$(jq 'length' "$REGISTRY_IDS_FILE")" -gt 0 ]; then
                jq -r '.[]' "$REGISTRY_IDS_FILE"
              else
                echo "no registry modules attached — attach one with: scooter-rebuild module add <name-or-id>"
              fi
              ;;
            ""|-h|--help) usage; exit 2 ;;
            *) echo "scooter-rebuild module: unknown subcommand '$sub'" >&2; usage; exit 2 ;;
          esac
          ;;
        publish)
          # Publish a local module under its name as the globally-unique registry
          # name, sent as { "module.nix": <contents> }.
          name="''${1:-}"; shift || true
          [ -n "$name" ] || { echo "scooter-rebuild publish: <name> required" >&2; exit 2; }
          path=$(module_path "$name")
          [ -e "$path" ] || { echo "scooter-rebuild: no local module '$name' to publish (see: scooter-rebuild module list)" >&2; exit 1; }
          visibility=private; description=""
          while [ "$#" -gt 0 ]; do
            case "$1" in
              --public)      visibility=public; shift ;;
              --private)     visibility=private; shift ;;
              --description)  description="''${2:-}"; shift 2 ;;
              *) echo "scooter-rebuild publish: unknown arg '$1'" >&2; exit 2 ;;
            esac
          done
          body=$(jq -n --arg n "$name" --arg v "$visibility" --arg d "$description" \
                    --rawfile c "$path" \
                    '{name:$n, visibility:$v, files:{"module.nix":$c}} + (if $d == "" then {} else {description:$d} end)')
          resp=$(agent-broker modules -X POST -H "Content-Type: application/json" -d "$body") \
            || { echo "scooter-rebuild: publish failed" >&2; exit 1; }
          # A non-2xx comes back as JSON {detail:...} without an id.
          if id=$(printf '%s' "$resp" | jq -er '.id' 2>/dev/null); then
            ver=$(printf '%s' "$resp" | jq -r '.version')
            echo "published $name (#$id, $visibility, v$ver) — others attach it with: scooter-rebuild module add $name"
          else
            echo "scooter-rebuild: publish rejected: $(printf '%s' "$resp" | jq -r '.detail // .' 2>/dev/null || printf '%s' "$resp")" >&2
            exit 1
          fi
          ;;
        ""|-h|--help) usage; exit 2 ;;
        *) echo "scooter-rebuild: unknown command '$cmd'" >&2; usage; exit 2 ;;
      esac
    '';
  };
in
{
  options.programs.scooterModule = {
    enable = lib.mkEnableOption "runtime application of a mounted .scooter/module.nix via switch-to-configuration";

    dir = lib.mkOption {
      type = lib.types.str;
      default = "/etc/agent-sandbox/scooter";
      description = ''
        Mount path of the DEPLOYMENT's .scooter dir (contains module.nix). Used only as a
        FALLBACK extra module when no --module is passed and the file is non-empty.

        NOT the agent's own modules: those live at /etc/scooter/modules (a symlink to the
        workspace PVC) and are imported by local-modules.nix on EVERY converge. Pointing
        this option there would double-import them — once via local-modules, once spliced
        in as the extra --module.
      '';
    };

    nixpkgs = lib.mkOption {
      type = lib.types.str;
      description = ''
        Store path to the pinned nixpkgs the in-pod toplevel build uses (same rev
        the image was built from). Injected by the image builder so the build is
        deterministic + offline.
      '';
    };

    applyOnBoot = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Run scooter-apply-module once at boot if a module is mounted.";
    };

    extraReconvergeModules = lib.mkOption {
      # Nix expression strings the re-converge always layers on the base config, so
      # the rebuilt toplevel keeps what is currently active (every re-converge
      # re-declares the list in the system it builds).
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "/nix/store/…-keep-vm-units.nix" ];
      description = "Extra module exprs always layered into the runtime re-converge (keeps currently-running config).";
    };

    extraReconvergeModuleFiles = lib.mkOption {
      # The same list addressed as repo-relative paths resolved against the vendored
      # tree, since an absolute flake path would drag the whole repo into the sandbox
      # closure; a module the image imports but this list omits is dropped by the
      # first self-modify.
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "contrib/aws/sandbox.nix" ];
      description = "Repo-relative module files always layered into the runtime re-converge, resolved against the baked tree.";
    };

    modulesTree = lib.mkOption {
      # The vendored sandbox-os source tree the in-pod build needs; base-config.nix
      # sets it to the already-baked path on re-converge so nothing is re-derived.
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Store path of the baked sandbox-os source tree; null = re-derive it (image build).";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ applyModule envStatus scooterRebuild ];

    # The in-pod build imports the modules tree (baked here) and the nixpkgs source,
    # which the image builder must add to extraDependencies itself because
    # cfg.nixpkgs is a bare string with no context.
    system.extraDependencies = [ effTree ];

    # The debuggable view of the layer list the apply script reads from the store.
    environment.etc."scooter/reconverge-modules.json".source = reconvergeModulesFile;

    # Apply the mounted module at boot (a missing module is a no-op).
    systemd.services.scooter-apply-module = lib.mkIf cfg.applyOnBoot {
      description = "Apply the mounted .scooter/module.nix via switch-to-configuration (async)";
      wantedBy = [ "multi-user.target" ];
      after = [ "nix-daemon.socket" ];
      # --detach returns immediately so this unit never gates readiness, and the
      # switch its child runs must leave this unit alone rather than restart it.
      restartIfChanged = false;
      stopIfChanged = false;
      unitConfig.X-StopOnReconfiguration = false;
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = "${applyModule}/bin/scooter-apply-module --detach";
      };
    };
  };
}
