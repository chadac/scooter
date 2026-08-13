# Compose the agent's OWN locally-authored NixOS modules into the re-converge.
#
# This is how the agent changes its environment now (self-modify): it EDITS files
# under /etc/scooter/modules/ and runs `scooter-apply-module` (switch). This module —
# always part of the sandbox-os base config, so it participates in EVERY re-converge —
# enumerates that directory and `imports` every `*.nix` file it finds.
#
# /etc/scooter/modules is a SYMLINK to /workspace/.scooter/modules on the workspace
# PVC (durable across suspend/resume, writable by the agent since HOME=/workspace) —
# see the tmpfiles rule in default.nix. So the agent's edits survive restarts and
# compose deterministically at converge time.
#
# IMPURE by nature: it reads a RUNTIME directory during the in-pod `nix build
# --impure` (the same impurity scooter-apply-module already relies on). FAIL-SAFE:
# the directory absent / empty (nothing authored yet) -> imports NOTHING, so the pod
# boots on the baseline config. A broken *.nix that IS present fails the `nix build`
# gate in scooter-apply-module (surfaced, never a silent bad switch).
#
# Mirrors broker-modules.nix (deployment DEFAULTS, fetched from the broker); this is
# the agent's OWN local half. Both compose into the same switch.

{ lib, ... }:

let
  # The agent-editable modules dir. HARDCODED to /etc/scooter/modules in prod.
  # SCOOTER_LOCAL_MODULES_DIR is a TEST-ONLY hook (the nixosTest points it at a store
  # fixture since it can't write the real path pre-boot) — prod NEVER sets it, so the
  # path is effectively hardcoded. (Same test-only idiom as broker-modules.nix.)
  envDir = builtins.getEnv "SCOOTER_LOCAL_MODULES_DIR";
  dir = if envDir != "" then envDir else "/etc/scooter/modules";

  # Every `*.nix` file directly in the dir is a module to import. (readDir follows the
  # /etc/scooter/modules -> PVC symlink.) Absent dir / no .nix files -> no imports.
  modulePaths =
    if builtins.pathExists dir
    then
      let
        entries = builtins.readDir dir;
        isNix = name: type: type == "regular" && lib.hasSuffix ".nix" name;
        names = builtins.filter (n: isNix n entries.${n}) (builtins.attrNames entries);
      in
      map (n: /. + "${dir}/${n}") names
    else [ ];
in
{
  imports = modulePaths;
}
