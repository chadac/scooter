# nixosTest: the nix-dev-env skill's documented workflow actually works.
#
# The skill tells the agent how to build/install a tool with nix in the sandbox.
# This runs the documented commands and asserts the tool ends up runnable — so
# the skill can't silently drift from reality.
#
# Hermetic: pre-seed the package in the store so `nix profile install` / the
# documented build resolves offline.
#
# RED until Stage 5 (the skill exists + nix profile install works in-image with
# the writable store).

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-nix-build-skill";

  nodes.machine = { config, pkgs, ... }: {
    imports = [ sandboxModule ];
    # A package the skill's example installs — available offline.
    system.extraDependencies = [ pkgs.hello ];
  };

  testScript = ''
    machine.wait_for_unit("default.target")
    machine.wait_for_unit("nix-daemon.socket")

    # The documented "install a tool with nix" step (the skill's canonical
    # example). After it, the tool is on PATH and runs.
    machine.succeed("nix profile install nixpkgs#hello 2>&1 | tail -5 || true")
    machine.succeed("hello >/dev/null")

    # The built tool lands under the user's nix profile on PATH.
    machine.succeed("command -v hello | grep -q nix-profile")
  '';
}
