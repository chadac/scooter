# Tools the sandbox ships as nix-stubs shims: the image carries the build recipe
# and the tool arrives on first use. Lives under modules/sandbox-os/ so the in-pod
# re-converge evaluates the same declarations.

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

  marimo = pkgs.marimo;

  # Multi-output (out + man); the shim must target `out` or it execs a directory.
  ttyd = { package = pkgs.ttyd; output = "out"; };

  # The prebuilt release, not nixpkgs: the VS Code agent-host bridge needs VS Code >= 1.141.
  code-server = pkgs.callPackage ../../contrib/code-server/code-server-bin { };

  # The Agent Host Protocol server code-server bridges to (contrib/code-server/sandbox.nix).
  scooter-vscode-ahp = pkgs.callPackage ../../contrib/code-server/ahp { };

  awscli2 = { package = pkgs.awscli2; bins = [ "aws" "aws_completer" ]; };

  # The forge CLIs (contrib/github, contrib/gitlab), authenticated by the broker's forge proxy.
  gh = pkgs.gh;
  glab = pkgs.glab;

  # contrib/gcp's CLIs, authenticated the same way.
  google-cloud-sdk = { package = pkgs.google-cloud-sdk; bins = [ "gcloud" "gsutil" "bq" ]; };

  # Node for contribs' npm packages, fetched on first use.
  scooter-node = { package = pkgs.nodejs; bins = [ "node" "npm" "npx" ]; };
}
# contrib/docker's tools; dockerd and crun build only on Linux.
// pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
  docker = { package = pkgs.docker; bins = [ "docker" "dockerd" ]; };
  crun = pkgs.crun;
  k3d = pkgs.k3d;
  kubectl = { package = pkgs.kubectl; output = "out"; };
  # contrib/web-review's headless screenshots, when no review page is open.
  chromium = pkgs.chromium;
}

