# scooter-apply-module — THE switch engine, a plain derivation shared by BOTH images.
#
# One `pkgs.callPackage`'d shell app both the bootstrap (its boot unit calls it directly)
# and the real config (scooter-rebuild's `switch` dispatches to it) put on PATH — so there
# is exactly ONE switch implementation, no drift.
#
# It decides "what to switch to" at RUNTIME:
#   scooter-apply-module switch [--detach]
#     1. If $SCOOTER_FIRSTBOOT_TARGET is a /nix/store path -> switch to it verbatim (the
#        bootstrap first-switch: the real toplevel is PREBUILT + present in the cloned/warm
#        upper; no build). A URL -> curl | gunzip -> a store path (agent-host directive).
#     2. Else BUILD the config flake at <configPath>:
#          nix build path:<configPath>#sandboxSystem.config.system.build.toplevel
#        The flake pins its own nixpkgs + imports ./custom (the agent's workspace-PVC
#        modules), so this ONE build covers the real-config re-converge.
#
# Everything AROUND the branch is the invariant switch core, lifted VERBATIM from the
# original runtime-converge.nix scooter-apply-module: status/log protocol, --detach
# re-exec-as-a-transient-systemd-unit (the cgroup lesson — the background switch must
# outlive the boot unit that switch-to-configuration restarts), nix-env --set generation
# register, systemd-run --scope switch-to-configuration, health-gate on NEW failed units
# -> rollback to the prior generation on regression.

{ lib
, writeShellApplication
, nix
, coreutils
, systemd
, gnugrep
, gawk
, curl
, gzip
, systemProfile ? "/nix/var/nix/profiles/system"
, statusDir ? "/run/scooter/env-switch"
, configPath ? "/etc/scooter/config"
, directiveEnv ? "SCOOTER_FIRSTBOOT_TARGET"
}:

writeShellApplication {
  name = "scooter-apply-module";
  runtimeInputs = [ nix coreutils systemd gnugrep gawk curl gzip ];
  # The in-pod build IS the validation gate; keep shellcheck OFF to match the original
  # (its dynamic `$0` re-exec + splicing tripped SC otherwise).
  checkPhase = "";
  text = ''
    # scooter-apply-module switch [--detach] — resolve/build the target toplevel, then
    # switch, with generation registration + health-gated auto-rollback. See the header.
    #
    # Safety model: a build failure (branch 2) exits non-zero BEFORE any profile/switch
    # change — the gate. Each good target is registered as a system generation; if the
    # switch then leaves NEW failed units, we roll the profile back to the prior generation
    # and re-switch, so a bad config can never leave the sandbox stuck broken. Idempotent.
    set -euo pipefail

    systemProfile=${lib.escapeShellArg systemProfile}
    config_path=${lib.escapeShellArg configPath}
    directive="''${${directiveEnv}:-}"

    # --- arg parse (accept a leading `switch` verb for CLI parity; --detach) ------
    detach=0
    while [ $# -gt 0 ]; do
      case "$1" in
        switch) shift ;;                 # the only verb; tolerated for `… switch` callers
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

    # --- --detach: re-exec THIS run in a SEPARATE systemd unit, then return ---
    # The background switch must OUTLIVE its caller. setsid alone is NOT enough: the child
    # stays in the CALLER's cgroup — and the boot unit (scooter-firstboot / the real
    # config's apply unit) is exactly a unit switch-to-configuration RESTARTS (its own diff
    # includes itself), so systemd tears down that cgroup mid-switch and kills the child
    # BEFORE it writes `done`. Run the child as its OWN transient unit (systemd-run) so it
    # lives in a separate cgroup, survives the restart, and writes its terminal status.
    # --collect reaps it. A switch already in flight (building|switching) is refused.
    if [ "$detach" -eq 1 ]; then
      mkdir -p "$status_dir"
      cur=$(cat "$status_dir/status" 2>/dev/null || echo idle)
      if [ "$cur" = "building" ] || [ "$cur" = "switching" ]; then
        echo "scooter-apply-module: a switch is already in progress ($cur) — refusing" >&2
        exit 3
      fi
      write_status building
      # Re-exec the SAME script WITHOUT --detach as a transient unit, log appended so the
      # caller's `building` line is preserved. Not tied to this unit's lifetime.
      systemd-run --collect --quiet \
        --unit="scooter-env-switch-$$" \
        --property=StandardOutput="append:$status_dir/log" \
        --property=StandardError="append:$status_dir/log" \
        "$0"
      echo "scooter-apply-module: applying in the background — poll scooter-env-status"
      exit 0
    fi

    # The foreground (real) run maintains status too, so a synchronous call (tests / direct)
    # reports its phases.
    write_status building

    # On ANY unexpected exit before the explicit done/failed writes, mark failed so a poller
    # never sees a stuck "building" after the process died.
    trap 'rc=$?; if [ "$rc" -ne 0 ]; then write_status failed "scooter-apply-module exited $rc"; fi' EXIT

    # --- BRANCH: resolve a PREBUILT target, or BUILD the config flake -------------
    if [ -n "$directive" ]; then
      case "$directive" in
        http://*|https://*)
          # agent-host directive URL: a gzipped bare store path. curl | gunzip -> the path.
          echo "scooter-apply-module: resolving directive $directive"
          toplevel=$(curl -fsSL "$directive" | gzip -d | head -n1 | tr -d '[:space:]') ;;
        /*)
          # An absolute LOCAL path (the prod happy path: a /nix/store toplevel present in
          # the cloned upper; also accepts a symlink handle like a specialisation link).
          echo "scooter-apply-module: using prebuilt target $directive"
          toplevel="$directive" ;;
        *)
          echo "scooter-apply-module: bad ${directiveEnv} (need an absolute path or URL): $directive" >&2; exit 2 ;;
      esac
      # Canonicalize (a symlink handle -> its store path) and require a VALID toplevel
      # (present + has switch-to-configuration). If the directive is stale/absent, fail
      # loudly rather than switch to junk.
      toplevel=$(readlink -f "$toplevel" 2>/dev/null || echo "$toplevel")
      if [ ! -e "$toplevel/bin/switch-to-configuration" ]; then
        echo "scooter-apply-module: target $toplevel is not a valid system toplevel" >&2
        write_status failed "target $toplevel missing switch-to-configuration"
        exit 1
      fi
    else
      # No directive: build the config flake (the real-config re-converge). The flake at
      # config_path pins its own nixpkgs + imports ./custom, so this one build is the whole
      # generation. A build failure exits non-zero HERE (set -e), before any switch — the gate.
      if [ ! -e "$config_path/flake.nix" ]; then
        echo "scooter-apply-module: no directive and no config flake at $config_path — nothing to apply" >&2
        write_status idle
        trap - EXIT
        exit 0
      fi
      echo "scooter-apply-module: building toplevel from $config_path (flake #sandboxSystem)..."
      toplevel=$(nix build --no-link --print-out-paths --impure \
        "path:$config_path#sandboxSystem.config.system.build.toplevel")
    fi

    # --- the invariant switch core (lifted verbatim) -----------------------------
    # Remember the CURRENTLY-RUNNING system as the rollback target (NOT the profile link,
    # which nix-env --set is about to repoint). Empty on the very first apply.
    prev=$(readlink -f /run/current-system 2>/dev/null || readlink -f "$systemProfile" 2>/dev/null || true)

    # Snapshot units ALREADY failed before the switch, so we can tell a failure THE SWITCH
    # INTRODUCED from pre-existing noise. This is the real rollback signal — NOT
    # switch-to-configuration's exit code (unreliable in a container).
    failed_before=$(systemctl list-units --state=failed --plain --no-legend 2>/dev/null | awk '{print $1}' | sort || true)

    # Register the built/resolved toplevel as a NEW numbered generation, then switch.
    echo "scooter-apply-module: registering generation + switching to $toplevel..."
    write_status switching
    nix-env -p "$systemProfile" --set "$toplevel"

    # Run the switch in a TRANSIENT scope, detached from THIS unit: switch-to-configuration
    # restarts the changed-unit diff (which includes the boot unit if we ARE it) and would
    # SIGTERM us mid-switch if inline. A --scope process isn't a unit the switch manages, so
    # it survives. --scope runs SYNCHRONOUSLY and returns when the switch finishes. The exit
    # code is unreliable in a container, so IGNORE it and let the failed-unit diff decide.
    systemd-run --scope --collect --quiet \
      --unit="scooter-switch-$$" \
      "$toplevel/bin/switch-to-configuration" switch || true

    # Health gate (the AUTHORITATIVE signal): did the switch introduce any NEW failed units?
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
        nix-env -p "$systemProfile" --rollback || true
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
}
