# Stubs the sandbox or several contribs use; others live per contrib.

# `uvNixSrc` is the source of the uv-nix flake's `bin` branch: the image build passes the
# flake input, the re-converge the copy vendored at stub-args/uvNixSrc.
{ pkgs, uvNixSrc }:

{
  # uv-nix, not nixpkgs' uv: it takes its Python from nixpkgs and patches native wheels, so
  # `uv run` works on NixOS. Its default.nix reads only `pkgs` and release data, so both
  # call sites evaluate the same drv. It gets an overlay-free nixpkgs: it names glibc, zlib
  # and xz itself, and inside an overlay those are uncached non-bootstrap builds (nixpkgs
  # applies its stdenvOverrides after user overlays), so glibc would build from source.
  # nixpkgs' uv-build reads `pkgs.uv.meta.license`, which uv-nix-bin lacks, so it
  # borrows uv's; meta stays out of the drv.
  uv = {
    package = (import (uvNixSrc + "/default.nix") {
      pkgs = import pkgs.path { inherit (pkgs.stdenv.hostPlatform) system; };
    }).overrideAttrs (old: {
      meta = old.meta // { inherit (pkgs.uv.meta) license; };
    });
    bins = [ "uv" ];
  };

  # The skills steer the agent to `shell` + `tree`, since goose's built-in reads
  # the agent-host's filesystem.
  tree = pkgs.tree;

  # Multi-output (out + man); the shim must target `out` or it execs a directory.
  ttyd = { package = pkgs.ttyd; output = "out"; };

  # Node for contribs' npm packages (skills, mcpservers).
  scooter-node = { package = pkgs.nodejs; bins = [ "node" "npm" "npx" ]; };
}
# Shared by contrib/docker and contrib/k8s.
// pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
  kubectl = { package = pkgs.kubectl; output = "out"; };
}
