# config-root — assemble the /etc/scooter/config FLAKE the firstboot switch builds.
#
# The bootstrap image carries NO real system. The real system lives in a flake at
# /etc/scooter/config, and `scooter-apply-module` (no directive) builds
# `path:/etc/scooter/config#sandboxSystem.config.system.build.toplevel` + switches to it.
#
# LAYOUT (critical): modules/sandbox/root references its siblings by REPO-RELATIVE paths
# (carry-over.nix: `../../../pkgs/broker-tools`). So the flake must reproduce the repo layout —
# the config tree at <out>/modules/sandbox/root, with <out>/pkgs/broker-tools + the broker
# cli.py vendored alongside at the SAME depth — exactly the `modulesTree` reconverge-inputs.nix
# already builds. We REUSE that tree (single source of truth; no drift) and drop a flake.nix at
# its root whose sandboxSystem imports ./modules/sandbox/root.
#
#   <out>/                       (== reconverge-inputs.modulesTree + flake.nix + custom/)
#     flake.nix                  # sandboxSystem = ./modules/sandbox/root + isContainer + ./custom
#     modules/sandbox/root/      # the real config (vendored, repo-relative deps resolve)
#     pkgs/broker-tools/         # vendored sibling (carry-over.nix's ../../../pkgs/broker-tools)
#     services/broker/…/cli.py   # vendored sibling
#     custom/                    # no-op default.nix; the workspace-PVC mount shadows it
#
# In prod the warm Job builds sandboxSystem into the PVC (golden) + config/custom is bind-
# mounted from the workspace PVC (agent-editable). See modules/sandbox/bootstrap/config-root-flake.md.

{ lib
, runCommand
, pkgs
  # (nix not needed — we no longer lock in-sandbox; see the runCommand note.)
  # The nixpkgs flake REF config/root pins — a normal flake ref string like
  # `github:NixOS/nixpkgs/<rev>`, NOT a store path. Rationale (user, 2026-08-17): the bootstrap
  # image carries NO nixpkgs; nixpkgs only matters at BUILD time, and in prod config/root is built
  # ONCE by the golden/warm build (which has network) then cloned — the pod never builds it. So a
  # standard github: pin is correct + is what a user's OWN sandbox flake would look like. Avoids
  # the `path:<store>` input that gets re-materialized as a symlinked source in the nixosTest VM.
, nixpkgsRef
  # The initial config/custom/default.nix contents. Defaults to a NO-OP — in prod the
  # workspace-PVC mount at /etc/scooter/config/custom shadows it with the agent's authored
  # modules. Tests pass a concrete module to exercise the root+custom layering.
, customModule ? ''
    # config/custom — the agent's own NixOS modules (edit here, then scooter-rebuild switch).
    # This shipped placeholder is a NO-OP; the workspace-PVC mount at /etc/scooter/config/custom
    # shadows it with the agent's real modules.
    { ... }: { }
  ''
}:

let
  # The vendored real-config tree (modules/sandbox/root + pkgs/broker-tools + cli.py at repo
  # layout) — the SAME derivation the in-pod re-converge uses. Reused so config/root and the
  # runtime re-converge never drift.
  inherit (import ../../../modules/sandbox/root/runtime-converge/reconverge-inputs.nix {
    inherit pkgs lib;
  }) modulesTree;

  flakeNix = ''
    {
      description = "scooter sandbox real system (config/root + agent config/custom)";
      inputs.nixpkgs.url = "${nixpkgsRef}";
      outputs = { self, nixpkgs }: {
        sandboxSystem = nixpkgs.lib.nixosSystem {
          system = "x86_64-linux";
          modules = [
            ./modules/sandbox/root
            { boot.isContainer = true; }
            # config/custom: the agent's own modules (workspace-PVC mounted, layered AFTER root
            # so it extends/overrides but can't break the base). A no-op ships until the mount
            # shadows it.
            ./custom
          ];
        };
      };
    }
  '';

in
# We do NOT bake flake.lock here: a `github:` ref needs NETWORK to lock, and the nix build
# SANDBOX blocks network. Instead, the lock is created when config/root is first BUILT — the
# golden/warm build (which has network). The in-pod re-converge passes
# `--no-update-lock-file --no-write-lock-file` (scooter-rebuild), so it never tries to write a
# lock into the read-only store path; it uses the lock the golden build produced (carried in the
# cloned snapshot alongside config/root). A pod without that lock is the rare no-snapshot
# fallback — it re-locks over the network like any first flake build.
runCommand "scooter-config-root"
  {
    inherit flakeNix;
    customDefault = customModule;
    passAsFile = [ "flakeNix" "customDefault" ];
  } ''
    mkdir -p $out/custom
    # The vendored tree gives <out>/modules/sandbox/root + pkgs/ + services/ at repo layout.
    cp -r ${modulesTree}/. $out/
    chmod -R u+w $out
    cp $flakeNixPath $out/flake.nix
    cp $customDefaultPath $out/custom/default.nix
  ''
