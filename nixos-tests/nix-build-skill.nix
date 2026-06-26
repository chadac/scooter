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

  nodes.machine = { config, pkgs, lib, ... }: {
    imports = [ sandboxModule ];

    # Resolve OFFLINE: pin the `nixpkgs` registry at the test's own nixpkgs source
    # (a path-flake) and pre-seed both that source and the built `hello`, so
    # `nix profile install nixpkgs#hello` evaluates from the store and the output
    # is already realised — no fetch, no build. Production uses a github: ref over
    # the network; the documented command is identical.
    devEnvNix.nixpkgs = lib.mkForce "path:${pkgs.path}";
    system.extraDependencies = [ pkgs.hello pkgs.path ];
  };

  testScript = ''
    machine.wait_for_unit("default.target")
    machine.wait_for_unit("nix-daemon.socket")

    # The skill's canonical "install a tool with nix" step. It resolves via the
    # pinned `nixpkgs` registry alias and installs into the user's nix profile.
    machine.succeed("nix profile install nixpkgs#hello")

    # The installed tool is on PATH (login shell picks up ~/.nix-profile/bin) and
    # runs — proving the documented workflow end to end.
    hello = machine.succeed("bash -l -c 'command -v hello'").strip()
    assert "nix-profile" in hello, f"hello not under the nix profile: {hello!r}"
    machine.succeed("bash -l -c 'hello' >/dev/null")
  '';
}
