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
, nix
, nixpkgs          # the nixpkgs flake SOURCE (path) to pin config/root at
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
      inputs.nixpkgs.url = "path:${nixpkgs}";
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
# The flake.lock pinning the `path:` nixpkgs input is BAKED (below) so the in-pod `nix build`
# never tries to WRITE a lock into the read-only store path (a bare `nix build path:<store>#…`
# errors "Read-only file system" without a pre-existing lock). The narHash of a path input is
# content-only (no network), so this is deterministic + offline.
runCommand "scooter-config-root"
  {
    inherit flakeNix;
    customDefault = customModule;
    passAsFile = [ "flakeNix" "customDefault" ];
    nativeBuildInputs = [ nix ];
    # nix flake needs these in the sandbox.
    requiredSystemFeatures = [ ];
  } ''
    export HOME=$TMPDIR NIX_STATE_DIR=$TMPDIR/nix/var NIX_STORE_DIR=/nix/store
    # Assemble into a WRITABLE staging dir first (nix flake lock must write flake.lock).
    stage=$TMPDIR/config-root
    mkdir -p "$stage/custom"
    cp -r ${modulesTree}/. "$stage/"
    chmod -R u+w "$stage"
    cp $flakeNixPath "$stage/flake.nix"
    cp $customDefaultPath "$stage/custom/default.nix"
    # Generate the lock in-sandbox (offline path-input narHash). --extra-experimental-features
    # so it works regardless of the builder's nix.conf.
    nix --extra-experimental-features 'nix-command flakes' \
      flake lock --offline "$stage" 2>&1 || true
    # Ship the fully-assembled tree (incl. flake.lock) to $out.
    cp -r "$stage" "$out"
  ''
