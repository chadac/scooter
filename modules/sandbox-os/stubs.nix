# Tools the sandbox ships as nix-stubs SHIMS: the image carries the build recipe,
# the tool itself arrives on first use. `nix run .#stubs-gen` regenerates
# stubs.lock; the overlay in flake.nix turns these into `pkgs.<attr>`.
#
# Lives under modules/sandbox-os/ so the in-pod re-converge (which vendors this
# tree) evaluates the same declarations instead of rebuilding the tools at full
# size. See PR #502.

{ pkgs }:

{
  uv = { package = pkgs.uv; bins = [ "uv" ]; };

  # goose's built-in `tree` reads the agent-host's filesystem, not the sandbox's,
  # so the skills steer the agent to `shell` + `tree`.
  tree = pkgs.tree;

  marimo = pkgs.marimo;

  # Multi-output (out + man); the shim must target `out` or it execs a directory.
  ttyd = { package = pkgs.ttyd; output = "out"; };

  code-server = pkgs.code-server;

  awscli2 = { package = pkgs.awscli2; bins = [ "aws" "aws_completer" ]; };
}
