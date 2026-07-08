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

      module=${lib.escapeShellArg cfg.dir}/module.nix
      detach=0
      while [ $# -gt 0 ]; do
        case "$1" in
          --module) module="$2"; shift 2 ;;
          --detach) detach=1; shift ;;
          *) echo "scooter-apply-module: unknown arg: $1" >&2; exit 2 ;;
        esac
      done

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

      # --- --detach: re-exec THIS run in the background, then return ------------
      # setsid detaches from the caller (the agent-host exec / the boot unit) so the
      # switch outlives it; all output -> the log; the background run writes status.
      # mkdir the status dir FIRST (foreground) so the log redirect can't race it
      # (the run_background mkdir-before-& lesson). A switch already in flight
      # (status=building|switching) is refused — no overlapping switches in one pod.
      if [ "$detach" -eq 1 ]; then
        mkdir -p "$status_dir"
        cur=$(cat "$status_dir/status" 2>/dev/null || echo idle)
        if [ "$cur" = "building" ] || [ "$cur" = "switching" ]; then
          echo "scooter-apply-module: a switch is already in progress ($cur) — refusing" >&2
          exit 3
        fi
        write_status building
        # Re-exec the SAME command (on PATH via systemPackages) WITHOUT --detach so
        # the child does the real foreground work + maintains status. "$0" resolves
        # to this script's store path, so it's the exact same build.
        setsid "$0" --module "$module" > "$status_dir/log" 2>&1 < /dev/null &
        echo "scooter-apply-module: applying in the background — poll scooter-env-status"
        exit 0
      fi

      # The foreground (real) run also maintains status, so a detached run reports
      # its phases + a synchronous run (tests / direct call) does too.
      write_status building

      if [ ! -e "$module" ]; then
        echo "scooter-apply-module: no module at $module — nothing to apply" >&2
        write_status idle
        exit 0
      fi

      # On ANY unexpected exit before we reach the explicit done/failed writes, mark
      # failed so a poller never sees a stuck "building" after the process died.
      trap 'rc=$?; if [ "$rc" -ne 0 ]; then write_status failed "scooter-apply-module exited $rc"; fi' EXIT

      echo "scooter-apply-module: building toplevel (base + $module)..."
      # Build base config + the module. --impure so we can read the path; the
      # nixpkgs + modules source are fixed store paths baked in. We re-inject
      # programs.scooterModule.nixpkgs so the re-evaluated base config (which
      # imports this same module) type-checks — it has no default. A build failure
      # exits non-zero HERE (set -e), before any profile/switch change: the gate.
      toplevel=$(nix build --no-link --print-out-paths --impure --expr "
        (import ${baseConfig} {
          nixpkgs = ${cfg.nixpkgs};
          modulesPath = ${modulesSrc};
          extraModules = [
            ({ lib, ... }: { programs.scooterModule.nixpkgs = lib.mkForce ${cfg.nixpkgs}; })
            # Layer the currently-running system's extra config (so the switch
            # preserves what's already active — see extraReconvergeModules).
            ${lib.concatStringsSep "\n            " cfg.extraReconvergeModules}
            $module
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
    environment.systemPackages = [ applyModule envStatus ];

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
