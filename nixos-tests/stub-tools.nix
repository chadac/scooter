# nixosTest: the IMAGE-TIME stubs (modules/sandbox-os/stubs.nix) are shims in a
# booted system, and the system closure carries their recipes but not their
# packages. Replaces lazy-stub.nix + mklazytool.nix.
#
# Not the same mechanism as injected-tool.nix, which covers a tool resolved from
# a flake MOUNTED AT RUNTIME (programs.injectedTools) and has no baked recipe.
#
# Hermetic: the VM has no network, so the real `uv` output is pre-seeded.

{ pkgs, lib, sandboxModule, stubOverlay, deploymentModules ? [ ] }:

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

  # The contribs' sandbox halves, composed exactly as pkgs/sandbox-os does. #717 moved
  # this layer out of modules/sandbox-os into the image builder, and the `aws` stub
  # asserted below is declared by contrib/aws/sandbox.nix — so `sandboxModule` alone
  # leaves `aws` off PATH, and the closure assertion passes VACUOUSLY. Why: PR #718.
  contribSandbox = import ../contrib/sandbox-modules.nix {
    inherit lib;
    extraModules = deploymentModules;
  };
in
pkgs.testers.runNixOSTest {
  name = "dev-env-stub-tools";

  # mkForce: runNixOSTest defines node.pkgs itself, from the outer pkgs.
  node.pkgs = lib.mkForce stubbedPkgs;

  nodes.machine = { ... }: {
    imports = [ sandboxModule ] ++ contribSandbox.modules;

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
        # Resolve the path in its OWN succeed(), so a tool that is missing from PATH
        # fails HERE. `cat $(command -v x)` with x absent runs `cat` with no argument,
        # which reads stdin and blocks until the driver's global timeout — a missing
        # stub then costs a 60-minute job that cannot say what was wrong. Why: PR #718.
        for tool in ("uv", "aws"):
            path = machine.succeed(f"command -v {tool}").strip()
            shim = machine.succeed(f"cat {path}")
            assert "nix-stubs exec" in shim, f"{tool} on PATH is not a stub:\n{shim}"

    # The whole point: the image ships build recipes, not the tools. awscli2 is
    # ~449 MB built and ~8 MB as a recipe.
    with subtest("the system closure carries recipes, not packages"):
        closure = machine.succeed("nix-store -q --requisites /run/current-system").split()
        assert "${realAwsOut}" not in closure, \
            "LEAK: awscli2's built output is in the image closure"
        # One blob for the whole set, not one per tool: the pack is opaque, so
        # per-stub blobs re-ship the stdenv chain they share (chadac/nix-stubs#3).
        assert any("-recipe-stub-set" in p for p in closure), \
            "MISSING RECIPE: no recipe blob in the closure, so `aws` could never be realised"

        # A recipe travels as that blob and never as store derivations: a .drv in
        # the closure names unrealised build-time outputs, and enumerating it is
        # what took down the image build (chadac/nix-stubs#3).
        drvs = [p for p in closure if p.endswith(".drv")]
        assert not drvs, f"the image closure ships store derivations: {drvs}"

    with subtest("a shim resolves its output and execs the real tool"):
        out = machine.succeed("uv --version")
        assert "uv" in out, f"uv --version did not run the real tool: {out!r}"
  '';
}
