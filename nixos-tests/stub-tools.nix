# nixosTest: the IMAGE-TIME stubs (modules/sandbox-os/stubs.nix) are shims in a
# booted system, and the system closure carries their recipes but not their
# packages. Replaces lazy-stub.nix + mklazytool.nix.
#
# Not the same mechanism as injected-tool.nix, which covers a tool resolved from
# a flake MOUNTED AT RUNTIME (programs.injectedTools) and has no baked recipe.
#
# Hermetic: the VM has no network, so the real `uv` output is pre-seeded.

{ pkgs, lib, sandboxModule, stubOverlay }:

let
  # The same overlay the image is built with (flake.nix). Applied through
  # `node.pkgs` because the test framework sets `nixpkgs.pkgs`, which conflicts
  # with the `nixpkgs.overlays` option.
  stubbedPkgs = import pkgs.path {
    inherit (pkgs.stdenv.hostPlatform) system;
    overlays = [ stubOverlay ];
  };

  realUv = pkgs.uv;
  realAwsOut = builtins.unsafeDiscardStringContext (toString pkgs.awscli2);
  awsRecipe = builtins.unsafeDiscardStringContext pkgs.awscli2.drvPath;
in
pkgs.testers.runNixOSTest {
  name = "dev-env-stub-tools";

  # mkForce: runNixOSTest defines node.pkgs itself, from the outer pkgs.
  node.pkgs = lib.mkForce stubbedPkgs;

  nodes.machine = { ... }: {
    imports = [ sandboxModule ];

    # Seed the real uv OUTPUT directly (not through the stub) so the shim finds
    # it already realised — the VM has no network to fetch it.
    system.extraDependencies = [ realUv ];

    nix.settings.experimental-features = [ "nix-command" ];
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    with subtest("the stubbed tools on PATH are shims, not packages"):
        # Assert on CONTENT, not the store path name: `readlink -f` follows through
        # symlinkJoin into the per-command shim, whose derivation is named for the
        # COMMAND (…-aws), so a name check reads as "not a stub" even when it is one.
        uv = machine.succeed("cat $(command -v uv)")
        assert "nix-stubs exec" in uv, f"uv on PATH is not a stub:\n{uv}"
        aws = machine.succeed("cat $(command -v aws)")
        assert "nix-stubs exec" in aws, f"aws on PATH is not a stub:\n{aws}"

    # The whole point: the image ships build recipes, not the tools. awscli2 is
    # ~449 MB built and ~8 MB as a recipe.
    with subtest("the system closure carries recipes, not packages"):
        closure = machine.succeed("nix-store -q --requisites /run/current-system")
        assert "${realAwsOut}" not in closure, \
            "LEAK: awscli2's built output is in the image closure"
        assert "${awsRecipe}" in closure, \
            "MISSING RECIPE: awscli2's .drv is absent, so `aws` could never be realised"

    with subtest("a shim resolves its output and execs the real tool"):
        out = machine.succeed("uv --version")
        assert "uv" in out, f"uv --version did not run the real tool: {out!r}"
  '';
}
