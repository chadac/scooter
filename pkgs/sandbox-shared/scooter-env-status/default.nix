# scooter-env-status — the agent's window into the (async) env switch. A plain derivation
# shared by both images (bootstrap + real config); pure status-reading of statusDir.
#
# DESIGN BOILERPLATE — impl lifted VERBATIM from runtime-converge.nix:304-... (envStatus).
# Prints the current status; on failure, the error + full build/switch log so the agent can
# read the exact error and fix its config. Exit mirrors the state: 0=done/idle, 1=failed,
# 2=in-progress (building/switching). Reads ONLY statusDir — nothing image-specific.

{ lib, writeShellApplication, coreutils
, statusDir ? "/run/scooter/env-switch"
}:

writeShellApplication {
  name = "scooter-env-status";
  runtimeInputs = [ coreutils ];
  # BOILERPLATE: shellcheck off while the body is a stub (the IMPL uses status_dir). The
  # real config's envStatus already sets checkPhase = "" — keep parity when lifted.
  checkPhase = "";
  text = ''
    # scooter-env-status [--log]   show the env-switch status (+ log on failure)
    set -euo pipefail
    status_dir=${lib.escapeShellArg statusDir}
    # IMPL: lift the body from runtime-converge.nix envStatus (status read + case + --log).
    echo "scooter-env-status: IMPL" >&2
    exit 0
  '';
}
