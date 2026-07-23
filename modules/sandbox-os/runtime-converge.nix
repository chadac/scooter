# programs.scooterModule — apply a deployment's `.scooter/module.nix` (a NixOS
# module) into the running sandbox AT RUNTIME via switch-to-configuration. No
# image rebuild, no flake ref: the module is MOUNTED (e.g. a ConfigMap) and the
# pod rebuilds its own toplevel (base config + the mounted module) and switches.
#
# This unifies the dev-env work: full NixOS-module power (packages, systemd
# services, config) delivered at runtime, the way the switch-specialisation spike
# proved (PID 1 survives, ~seconds, only the changed-unit diff restarts).
#
# Ships into the image:
#   - the base-config builder expression (runtime-converge/base-config.nix);
#   - the pinned nixpkgs + the modules/sandbox-os source, as store paths, so the
#     in-pod build needs no network/ref;
#   - `scooter-apply-module`: build <base + mounted module> -> switch.
#
# See docs/HYPERNIX_INJECTION.md.

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.scooterModule;

  # agent-broker (the authenticated broker curl wrapper) — used by scooter-rebuild's
  # registry subcommands (module add/detach + publish) to talk to the broker's module
  # registry with the pod's SA token. Same package that carry-over.nix puts on PATH.
  brokerTools = pkgs.callPackage ../../pkgs/broker-tools { };

  # The base-config entrypoint + vendored modules tree the in-pod build feeds to it.
  # Factored into a shared helper so the nixosTest pre-builds the re-converged
  # toplevel from the IDENTICAL derivations (else: cache miss -> offline from-source
  # build that hangs in the VM). See runtime-converge/reconverge-inputs.nix.
  inherit (import ./runtime-converge/reconverge-inputs.nix { inherit pkgs lib; })
    baseConfig modulesTree modulesSrc;

  # The canonical system profile — registering each switch here gives us the
  # numbered-generation ladder NixOS uses for rollback. The symlinks
  # (system, system-N-link) are plain files on the writable rootfs, NOT in the
  # (possibly overlay) Nix store, so they're writable even with a read-only lower.
  systemProfile = "/nix/var/nix/profiles/system";

  # Where scooter-apply-module writes its status/error/log — read by
  # scooter-env-status (the agent's poll) + the agent-host completion watcher. On
  # /run (tmpfs): a fresh boot starts with no stale status, and it's writable.
  statusDir = "/run/scooter/env-switch";

  applyModule = pkgs.writeShellApplication {
    name = "scooter-apply-module";
    # systemd provides `systemd-run` (the --detach path launches the background
    # converge as its own transient unit so it survives the boot unit's restart).
    runtimeInputs = [ pkgs.nix pkgs.coreutils pkgs.systemd pkgs.gnugrep pkgs.gawk ];
    checkPhase = "";
    text = ''
      # scooter-apply-module — re-converge this sandbox to include a NixOS module,
      # via switch-to-configuration, with generation registration + auto-rollback.
      #
      #   scooter-apply-module [--module <path>] [--detach]
      #
      # --module <path>   the module.nix to apply (default: the mounted
      #                   <scooterModule.dir>/module.nix — the boot/ConfigMap path).
      #                   The agent-host passes an uploaded path for a live apply.
      # --detach          run the build+switch in the BACKGROUND (setsid) and return
      #                   IMMEDIATELY. The foreground writes STATUS + a full combined
      #                   stdout/stderr LOG to ${statusDir} so the caller can poll
      #                   (scooter-env-status). Used by the boot converge (fast, non-
      #                   blocking startup) AND the agent's async modify_environment.
      #
      # Safety model: the in-pod `nix build` is the validation gate (a bad module
      # fails the build BEFORE any switch). Each good build is registered as a
      # system generation; if the switch then leaves the system with NEW failed
      # units, we roll the profile back to the prior generation and re-switch, so a
      # bad module can never leave the sandbox stuck in a broken config. Idempotent.
      set -euo pipefail

      # An EXTRA module to splice into the re-converge. Optional: with none, we build
      # the BASE config alone — which already imports local-modules (/etc/scooter/modules)
      # + broker/registry modules — so `scooter-rebuild switch` picks up the agent's
      # authored modules WITHOUT needing a --module. The legacy per-conversation module
      # ConfigMap (cfg.dir/module.nix) is used ONLY as a fallback when it exists and is
      # non-empty (the old deployment path); a missing/empty CM no longer blocks the
      # base re-converge.
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
      # No explicit --module: fall back to the deployment CM module IF it has content;
      # otherwise leave $module empty and re-converge the base config alone.
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

      # --- --detach: re-exec THIS run in a SEPARATE systemd unit, then return ---
      # The background converge must OUTLIVE its caller. setsid alone is NOT enough:
      # setsid escapes the controlling terminal + process group, but the child stays
      # in the CALLER'S cgroup — and the boot unit (scooter-apply-module.service) is
      # exactly a unit that switch-to-configuration RESTARTS (its own diff includes
      # itself), so systemd tears down that cgroup mid-switch and kills the child
      # BEFORE it writes `done`. The status then wedges at `switching` forever even
      # though the switch itself succeeded (system-path activates earlier, so the
      # tool still lands — but scooter-env-status reads a perpetual in-progress).
      #
      # Run the child as its OWN transient systemd unit (systemd-run) so it lives in
      # a separate cgroup, unmanaged by the switch, and survives the restart to write
      # its terminal status. --collect reaps the unit when it exits. The foreground
      # child does the real work WITHOUT --detach and maintains status/log. mkdir the
      # status dir FIRST (foreground) so the log redirect can't race it (the
      # run_background mkdir-before-& lesson). A switch already in flight
      # (status=building|switching) is refused — no overlapping switches in one pod.
      if [ "$detach" -eq 1 ]; then
        mkdir -p "$status_dir"
        cur=$(cat "$status_dir/status" 2>/dev/null || echo idle)
        if [ "$cur" = "building" ] || [ "$cur" = "switching" ]; then
          echo "scooter-apply-module: a switch is already in progress ($cur) — refusing" >&2
          exit 3
        fi
        write_status building
        # Re-exec the SAME command ("$0" = this script's store path, the exact same
        # build) WITHOUT --detach, as a transient unit. StandardOutput/Error -> the
        # log file (append so the caller's building status line is preserved). It is
        # NOT tied to this unit's lifetime, so it survives switch-to-configuration
        # restarting the boot unit.
        systemd-run --collect --quiet \
          --unit="scooter-env-switch-$$" \
          --property=StandardOutput="append:$status_dir/log" \
          --property=StandardError="append:$status_dir/log" \
          "$0" --module "$module"
        echo "scooter-apply-module: applying in the background — poll scooter-env-status"
        exit 0
      fi

      # The foreground (real) run also maintains status, so a detached run reports
      # its phases + a synchronous run (tests / direct call) does too.
      write_status building

      # If an EXPLICIT extra module was resolved ($module non-empty) but it's missing or
      # empty/whitespace, that's a no-op ONLY for that extra module — we still re-converge
      # the base config (which imports local-modules). A 0-byte file is not a valid Nix
      # module, so `import`ing it would fail the build; drop it and continue base-only.
      # (The per-conversation module ConfigMap is seeded with a 0-byte module.nix, so this
      # empty case is normal, not an error.)
      if [ -n "$module" ] && { [ ! -e "$module" ] || [ ! -s "$module" ] || [ -z "$(tr -d '[:space:]' < "$module")" ]; }; then
        echo "scooter-apply-module: extra module $module is missing/empty — re-converging base config only" >&2
        module=""
      fi

      # Genuine no-op: no extra module AND nothing for the base to pick up (no
      # local /etc/scooter/modules/*.nix and no attached registry modules). Building
      # base-only here would just rebuild the running config for nothing — and worse,
      # a sandbox with a placeholder nixpkgs (tests, or a not-yet-provisioned pod)
      # can't build at all. Exit idle WITHOUT building. Base-only re-converge still
      # runs whenever there IS something authored to pick up.
      if [ -z "$module" ]; then
        local_mods=""
        [ -d /etc/scooter/modules ] && local_mods=$(find -L /etc/scooter/modules -maxdepth 1 -name '*.nix' -type f 2>/dev/null | head -1)
        reg_mods=""
        [ -s /etc/scooter/registry-modules.json ] && reg_mods=$(tr -d '[]" \n\t' < /etc/scooter/registry-modules.json 2>/dev/null)
        if [ -z "$local_mods" ] && [ -z "$reg_mods" ]; then
          echo "scooter-apply-module: no module and nothing to converge — nothing to apply" >&2
          write_status idle
          exit 0
        fi
      fi

      # On ANY unexpected exit before we reach the explicit done/failed writes, mark
      # failed so a poller never sees a stuck "building" after the process died.
      trap 'rc=$?; if [ "$rc" -ne 0 ]; then write_status failed "scooter-apply-module exited $rc"; fi' EXIT

      if [ -n "$module" ]; then
        echo "scooter-apply-module: building toplevel (base + $module)..."
        module_expr="$module"
      else
        echo "scooter-apply-module: building toplevel (base config + local/registry modules)..."
        module_expr=""
      fi
      # Build the base config (+ the optional extra module). --impure so we can read the
      # module path + the local-modules dir; the nixpkgs + modules source are fixed store
      # paths baked in. We re-inject programs.scooterModule.nixpkgs so the re-evaluated
      # base config type-checks — it has no default. A build failure exits non-zero HERE
      # (set -e), before any profile/switch change: the gate. With no extra module this
      # still re-converges local-modules (/etc/scooter/modules) — the agent's authored
      # modules — since the base config imports them.
      toplevel=$(nix build --no-link --print-out-paths --impure --expr "
        (import ${baseConfig} {
          nixpkgs = ${cfg.nixpkgs};
          modulesPath = ${modulesSrc};
          extraModules = [
            # base-config.nix itself now force-sets programs.scooterModule.{enable,nixpkgs}
            # for the re-converge (it has the nixpkgs ref), so we do NOT set them here —
            # a second mkForce would conflict.
            # Layer the currently-running system's extra config (so the switch
            # preserves what's already active — see extraReconvergeModules).
            ${lib.concatStringsSep "\n            " cfg.extraReconvergeModules}
            $module_expr
          ];
        }).toplevel
      ")

      # Remember the current generation so we can roll back to it. (Empty on the
      # very first apply — nothing to roll back to; a failed first switch just
      # surfaces as a non-zero exit.)
      # Capture the CURRENTLY-RUNNING system (what's actually active, /run/current-
      # system) as the rollback target — NOT the profile link, which nix-env --set
      # is about to repoint. Re-switching to this path is what returns us to the
      # last-good config on failure.
      prev=$(readlink -f /run/current-system 2>/dev/null || readlink -f ${systemProfile} 2>/dev/null || true)

      # Snapshot the units that are ALREADY failed before the switch, so we can
      # tell a failure THE SWITCH INTRODUCED from pre-existing noise (a bare
      # sandbox may have unrelated degraded units). This is the real rollback
      # signal — NOT switch-to-configuration's exit code, which is unreliable in a
      # container (it returns non-zero for benign restart-skips even on success).
      failed_before=$(systemctl list-units --state=failed --plain --no-legend 2>/dev/null | awk '{print $1}' | sort || true)

      # Register the built toplevel as a NEW numbered system generation, then
      # switch to it. nix-env --set bumps /nix/var/nix/profiles/system to a fresh
      # system-N-link — this is the rollback ladder NixOS uses.
      echo "scooter-apply-module: registering generation + switching to $toplevel..."
      write_status switching
      nix-env -p ${systemProfile} --set "$toplevel"

      # Run the switch in a TRANSIENT systemd scope, detached from THIS unit.
      # switch-to-configuration restarts the changed-unit diff — which would
      # include scooter-apply-module.service if we're the boot unit — and would
      # SIGTERM us mid-switch if run inline. A --scope process isn't a unit the
      # switch manages, so it survives. `systemd-run --scope` runs the program
      # SYNCHRONOUSLY (it's the scope's main process) and returns when the switch
      # finishes — so no --wait/--pipe (both re-couple/break it) and no manual
      # polling are needed. The switch's exit code is unreliable in a container,
      # so we IGNORE it and let the failed-unit diff below decide success.
      systemd-run --scope --collect --quiet \
        --unit="scooter-switch-$$" \
        "$toplevel/bin/switch-to-configuration" switch || true

      # Health gate (the AUTHORITATIVE signal). The switch has finished (the scope
      # ran synchronously); did it introduce any NEW failed units? A unit
      # failed-before-and-after is pre-existing noise; a unit failed now but not
      # before is the bad module's doing -> roll back.
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
          # Roll the profile back to the prior generation and re-switch to it, so
          # the sandbox is left in the last-good config rather than a broken one.
          nix-env -p ${systemProfile} --rollback || true
          # Re-switch to the prior generation (same synchronous detached scope).
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

  # scooter-env-status — the agent's window into the (async) env switch. Prints the
  # current status; on failure, the error + the full build/switch log so the agent
  # can read the exact error and fix its module. Exit code mirrors the state so a
  # script can gate on it: 0=done/idle, 1=failed, 2=in-progress (building/switching).
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

  # scooter-rebuild — THE agent's environment entrypoint (nixos-rebuild-like). Owns
  # /etc/scooter (HARDCODED — no configurability). A thin dispatcher over the existing
  # switch machinery (scooter-apply-module / scooter-env-status) + local module editing
  # under /etc/scooter/modules (the symlinked, PVC-backed, agent-writable dir that
  # local-modules.nix composes) + the SHARED registry (attach/detach/publish via the
  # broker, which registry-modules.nix fetches into the same switch).
  #
  #   scooter-rebuild switch [--detach]     build + switch to the current config
  #   scooter-rebuild status [--log]        show the (async) switch status
  #   scooter-rebuild module list           list your authored modules
  #   scooter-rebuild module new <name>     create modules/<name>.nix from a template
  #   scooter-rebuild module edit <name>    $EDITOR modules/<name>.nix (create if absent)
  #   scooter-rebuild module show <name>    print modules/<name>.nix
  #   scooter-rebuild module rm <name>      delete modules/<name>.nix
  #   scooter-rebuild module search [q]     search the broker registry catalog
  #   scooter-rebuild module add <ref>      attach a registry module (name or id) + switch
  #   scooter-rebuild module detach <ref>   detach an attached registry module + switch
  #   scooter-rebuild module attached       list attached registry modules
  #   scooter-rebuild publish <name> [..]   publish local modules/<name>.nix to the registry
  scooterRebuild = pkgs.writeShellApplication {
    name = "scooter-rebuild";
    runtimeInputs = [ applyModule envStatus pkgs.coreutils brokerTools.agent-broker pkgs.jq ];
    text = ''
      set -euo pipefail

      # HARDCODED — scooter-rebuild owns /etc/scooter. modules/ is the agent-editable
      # dir (symlink -> workspace PVC) that local-modules.nix imports. The registry-ids
      # file is the attach-list registry-modules.nix fetches from the broker.
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

      # Reject a name that isn't a plain module basename (no path traversal / slashes).
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
          # Pass through --detach; scooter-apply-module with NO --module composes the
          # base config (which imports local + deployment/broker modules) -> the switch.
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
              # -L: MODULES_DIR is a symlink (-> the workspace PVC dir); find won't
              # descend a symlinked start point without it.
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
              # Query the broker catalog (own private + all public). No query -> all.
              q="''${1:-}"
              agent-broker "modules?q=$q" | jq -r '
                (.modules // []) as $m
                | if ($m | length) == 0 then "no modules found"
                  else ($m[] | "\(.name)  (#\(.id), \(.visibility))\(if (.description // "") != "" then "  — \(.description)" else "" end)")
                  end'
              ;;
            add|attach)
              # Attach a registry module by name OR numeric id. Resolve via the broker
              # so we store the CANONICAL name (the download endpoint tars under <name>/,
              # so registry-modules.json must hold names, not ids), and to fail fast on a
              # missing/invisible module before recording it.
              ref="''${1:-}"
              [ -n "$ref" ] || { echo "scooter-rebuild module add: <name-or-id> required" >&2; exit 2; }
              name=$(agent-broker "modules/$ref" | jq -er '.name') \
                || { echo "scooter-rebuild: registry module '$ref' not found (or not visible to you)" >&2; exit 1; }
              [ -f "$REGISTRY_IDS_FILE" ] || echo '[]' > "$REGISTRY_IDS_FILE"
              # Idempotent add: no-op if already attached; keep the list unique + sorted.
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
              # Remove an attached registry module. Accepts the stored name; also tries
              # resolving an id -> name so `detach <id>` works symmetrically with `add`.
              ref="''${1:-}"
              [ -n "$ref" ] || { echo "scooter-rebuild module detach: <name-or-id> required" >&2; exit 2; }
              [ -f "$REGISTRY_IDS_FILE" ] || { echo "no attached registry modules"; exit 0; }
              name="$ref"
              if ! jq -e --arg n "$name" 'index($n)' "$REGISTRY_IDS_FILE" >/dev/null 2>&1; then
                # Not a stored name — maybe an id; ask the broker for the canonical name.
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
          # Publish a LOCAL module (/etc/scooter/modules/<name>.nix) to the broker
          # registry. name = the local module name = the globally-unique registry name
          # (first publisher owns it; re-publishing your own bumps the version). Files
          # are sent as { "module.nix": <contents> } — the registry requires module.nix.
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
          resp=$(agent-broker -X POST modules -H "Content-Type: application/json" -d "$body") \
            || { echo "scooter-rebuild: publish failed" >&2; exit 1; }
          # A non-2xx comes back as a JSON {detail:...} without an id — surface it.
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
      description = "Mount path of the deployment's .scooter dir (contains module.nix).";
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
      # A list of Nix expression STRINGS (module paths or inline modules) that the
      # re-converge ALWAYS layers on top of the base config — so the rebuilt
      # toplevel reflects the CURRENTLY-RUNNING system, not just the bare base.
      # This is how a runtime-applied switch preserves what's already active
      # instead of dropping units the base config doesn't declare (e.g. the
      # nixosTest framework's backdoor.service — without this the switch stops the
      # test's control channel and the test hangs). The image sets none; a test or
      # a deployment that injects extra node-level config threads it here.
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "/nix/store/…-keep-backdoor.nix" ];
      description = "Extra module exprs always layered into the runtime re-converge (keeps currently-running config).";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ applyModule envStatus scooterRebuild ];

    # CRITICAL: the in-pod `nix build` imports the modules tree (shipped here) and
    # the nixpkgs source. cfg.nixpkgs is a bare string (no Nix context), so it is
    # NOT pulled into the image closure by itself — the IMAGE BUILDER must add the
    # nixpkgs source to system.extraDependencies (where it still has context).
    # Without both, the in-pod build fails with "path does not exist".
    system.extraDependencies = [ modulesTree ];

    # Apply the mounted module at boot (best-effort; a missing module is a no-op).
    # The agent-host can also exec scooter-apply-module on spawn/claim.
    systemd.services.scooter-apply-module = lib.mkIf cfg.applyOnBoot {
      description = "Apply the mounted .scooter/module.nix via switch-to-configuration (async)";
      wantedBy = [ "multi-user.target" ];
      after = [ "nix-daemon.socket" ];
      # NON-BLOCKING: --detach forks the build+switch into the background and the
      # ExecStart returns IMMEDIATELY, so this unit does NOT gate multi-user.target /
      # the sandbox's readiness. The sandbox is usable on the base config right away;
      # the converge lands live when it finishes, and the agent polls scooter-env-
      # status. A slow/failed converge no longer blocks startup or the agent's work.
      # The switch this unit's child runs will restart the changed-unit diff — which
      # would include THIS unit — and SIGTERM it. Tell the switch to leave it alone.
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
