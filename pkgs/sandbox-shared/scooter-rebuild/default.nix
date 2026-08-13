# scooter-rebuild — the ONE switch command, a plain derivation shared by BOTH images.
#
# DESIGN BOILERPLATE — the two runtime branches + the invariant switch core are sketched;
# the switch body is STUBBED (`# IMPL:` markers). Design stage of the PoC process.
#
# A single `pkgs.callPackage`'d shell app both images put on PATH — NOT a module option, NOT
# a per-caller compile-time hook. The "what to switch to" difference is decided at RUNTIME:
#
#   scooter-rebuild switch [--detach]
#     1. If $SCOOTER_FIRSTBOOT_TARGET is a /nix/store path -> use it verbatim (the bootstrap
#        first-switch: the real toplevel is PREBUILT + present in the cloned/warm upper; no
#        build). If it's a URL -> curl | gunzip -> a store path (agent-host directive).
#     2. Else BUILD the config flake at <configPath> (default /etc/scooter/config):
#          nix build path:<configPath>#sandboxSystem.config.system.build.toplevel
#        The flake pins its own nixpkgs + imports ./custom (the agent's workspace-PVC
#        modules), so this ONE build covers the real-config re-converge too. (Replaces the
#        old `nix build --expr "(import base-config { nixpkgs; modulesPath; … })"` — in the
#        Tier-C model the config IS a flake at a fixed path, so no baked-expr splicing.)
#
# Everything AROUND those two branches is invariant + lifted VERBATIM from the current
# runtime-converge.nix scooter-apply-module (lines ~109-297):
#   - the status/log protocol (statusDir; read by scooter-env-status),
#   - the --detach re-exec-as-a-transient-systemd-unit (the cgroup lesson: the background
#     switch must outlive the boot unit that switch-to-configuration restarts),
#   - nix-env -p <systemProfile> --set "$toplevel"   (generation register / rollback ladder),
#   - systemd-run --scope "$toplevel/bin/switch-to-configuration" switch,
#   - the health-gate on NEW failed units -> rollback to the prior generation on regression.
#
# So scooter-apply-module (the real config's re-converge) BECOMES this: same script, its
# build branch is #2. The bootstrap firstboot calls the SAME binary; its target is #1.

{ lib
, writeShellApplication
, nix
, coreutils
, systemd
, gnugrep
, gawk
, curl
, gzip
  # Canonical paths (were locals in runtime-converge.nix; now the derivation's knobs).
, systemProfile ? "/nix/var/nix/profiles/system"
, statusDir ? "/run/scooter/env-switch"
, configPath ? "/etc/scooter/config"
, directiveEnv ? "SCOOTER_FIRSTBOOT_TARGET"
}:

writeShellApplication {
  name = "scooter-rebuild";
  runtimeInputs = [ nix coreutils systemd gnugrep gawk curl gzip ];
  # BOILERPLATE: shellcheck off while the switch body is stubbed (unused vars until IMPL).
  # The real config's applyModule already sets checkPhase = ""; keep parity when lifted.
  checkPhase = "";
  text = ''
    # scooter-rebuild switch [--detach]   build/resolve the target -> switch, with
    # generation registration + health-gated auto-rollback. See default.nix header.
    set -euo pipefail

    systemProfile=${lib.escapeShellArg systemProfile}
    status_dir=${lib.escapeShellArg statusDir}
    config_path=${lib.escapeShellArg configPath}
    directive="''${${directiveEnv}:-}"

    # --- arg parse ---------------------------------------------------------------
    detach=0
    cmd="''${1:-}"; [ $# -gt 0 ] && shift || true
    while [ $# -gt 0 ]; do
      case "$1" in
        --detach) detach=1; shift ;;
        *) echo "scooter-rebuild: unknown arg: $1" >&2; exit 2 ;;
      esac
    done
    if [ "$cmd" != "switch" ]; then
      echo "usage: scooter-rebuild switch [--detach]" >&2; exit 2
    fi

    # IMPL: write_status() + the --detach re-exec-as-transient-unit block, lifted from
    # runtime-converge.nix:114-157 (status protocol + systemd-run re-exec). Unchanged.

    # --- BRANCH: resolve OR build the target toplevel ----------------------------
    if [ -n "$directive" ]; then
      case "$directive" in
        /nix/store/*) toplevel="$directive" ;;                       # prebuilt, in the upper
        http://*|https://*)
          # IMPL: toplevel=$(curl -fsSL "$directive" | gunzip | read-one-line store path)
          echo "scooter-rebuild: URL directive resolution — IMPL" >&2; exit 1 ;;
        *) echo "scooter-rebuild: bad SCOOTER_FIRSTBOOT_TARGET: $directive" >&2; exit 2 ;;
      esac
    else
      # IMPL: toplevel=$(nix build --no-link --print-out-paths \
      #   "path:$config_path#sandboxSystem.config.system.build.toplevel")
      echo "scooter-rebuild: flake build at $config_path — IMPL" >&2; exit 1
    fi

    # IMPL: the SHARED switch core (lifted verbatim from runtime-converge.nix:226-296):
    #   prev=$(readlink -f /run/current-system); failed_before=$(systemctl … failed)
    #   nix-env -p "$systemProfile" --set "$toplevel"
    #   systemd-run --scope … "$toplevel/bin/switch-to-configuration" switch
    #   health-gate on NEW failed units -> rollback (nix-env --rollback + re-switch) on regression
    #   write_status done | failed
    echo "scooter-rebuild: switch core — IMPL (target=$toplevel)" >&2
    exit 1
  '';
}
