# The stub set: tools the sandbox puts on PATH as nix-stubs SHIMS rather than as
# packages. A shim carries the package's build RECIPE (its .drv closure) and not
# the package, so the image ships kilobytes and the real tool materializes into
# the writable store the first time the agent runs it.
#
# `nix run .#stubs-gen` records these in stubs.lock; the overlay in flake.nix
# turns them into `pkgs.<attr>`, so a call site just uses `pkgs.marimo` and gets
# the shim. See modules/sandbox-os/README-stubs.md.
#
# This file lives under modules/sandbox-os/ on purpose: the in-pod re-converge
# vendors that tree (runtime-converge/reconverge-inputs.nix), so a self-modify
# evaluates the SAME declarations and keeps the tools lazy instead of rebuilding
# them at full size.
#
# What belongs here: expensive, PATH-facing leaf tools. Not libraries (nothing
# execs them, so there is no first-use hook), and not anything a build needs as
# an input.

{ pkgs }:

{
  # The agent's Python workflow tool. ~40 MB with its closure.
  uv = { package = pkgs.uv; bins = [ "uv" ]; };

  # goose's built-in `tree` reads the agent-host's filesystem, not the sandbox's,
  # so the skills steer the agent to `shell` + `tree` — which means `tree` has to
  # actually resolve in here.
  tree = pkgs.tree;

  # Web services. Declared unconditionally: a shim costs nothing until started,
  # and all three are enabled-by-default-but-not-running.
  marimo = pkgs.marimo;

  # ttyd is MULTI-OUTPUT (out + man). The old lazy stub resolved `nixpkgs#ttyd`
  # and got the `man` output first — it then tried to exec a directory and died
  # with "Is a directory", worked around by writing `ttyd.out` at the call site.
  # The lock records the output NAME, and the dispatcher resolves it with
  # `nix-store --query --binding out`, so the workaround is gone.
  ttyd = { package = pkgs.ttyd; output = "out"; };

  code-server = pkgs.code-server;

  # ~449 MB with its Python closure — far too heavy to bake for a tool most
  # conversations never touch. The credential_process helper
  # (scooter-aws-credentials) is a separate broker tool and stays eager.
  awscli2 = { package = pkgs.awscli2; bins = [ "aws" "aws_completer" ]; };
}
