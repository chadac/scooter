# nixosTest: the image-time stubs (every active stub set) are shims in a
# booted system, and the system closure carries their recipes but not their
# packages. The VM has no network, so the real `uv` output is pre-seeded.

{ pkgs, lib, sandboxModule, stubOverlayFor, deploymentModules ? [ ] }:

let
  # The repo's contribs plus one out-of-tree, with stubs.
  testModules = deploymentModules ++ [ ./fixtures/contrib-ext/contrib.nix ];

  # The overlay the image is built with, applied through `node.pkgs` because the framework's `nixpkgs.pkgs` conflicts with `nixpkgs.overlays`.
  stubbedPkgs = import pkgs.path {
    inherit (pkgs.stdenv.hostPlatform) system;
    overlays = [ (stubOverlayFor testModules) ];
  };

  # What the uv stub wraps (uv-nix), read off the stub so the seed follows stubs.nix.
  realUv = stubbedPkgs.uv.real;
  realAwsOut = builtins.unsafeDiscardStringContext (toString pkgs.awscli2);

  # The contribs' sandbox halves, composed exactly as pkgs/sandbox-os does, since the
  # `aws` stub asserted below is declared by contrib/aws/sandbox.nix.
  contribSandbox = import ../contrib/sandbox-modules.nix {
    inherit lib;
    extraModules = testModules;
  };
in
pkgs.testers.runNixOSTest {
  name = "dev-env-stub-tools";

  # runNixOSTest defines node.pkgs itself, hence the mkForce.
  node.pkgs = lib.mkForce stubbedPkgs;

  nodes.machine = { ... }: {
    imports = [ sandboxModule ] ++ contribSandbox.modules;

    # Seed the real uv output so the shim finds it already realised.
    system.extraDependencies = [ realUv ];

    nix.settings.experimental-features = [ "nix-command" ];
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    with subtest("the stubbed tools on PATH are shims, not packages"):
        # Assert on the shim's content, resolving the path in its own succeed() so a tool missing from PATH fails here rather than blocking `cat` on stdin.
        # Base set, in-tree contrib, out-of-tree contrib.
        for tool in ("uv", "aws", "hello"):
            path = machine.succeed(f"command -v {tool}").strip()
            shim = machine.succeed(f"cat {path}")
            assert "nix-stubs exec" in shim, f"{tool} on PATH is not a stub:\n{shim}"

    # The image ships build recipes, not the tools.
    with subtest("the system closure carries recipes, not packages"):
        closure = machine.succeed("nix-store -q --requisites /run/current-system").split()
        assert "${realAwsOut}" not in closure, \
            "LEAK: awscli2's built output is in the image closure"
        # One recipe blob for the whole set, not one per tool.
        assert any("-recipe-stub-set" in p for p in closure), \
            "MISSING RECIPE: no recipe blob in the closure, so `aws` could never be realised"

        # A recipe travels as that blob and never as store derivations.
        drvs = [p for p in closure if p.endswith(".drv")]
        assert not drvs, f"the image closure ships store derivations: {drvs}"

    with subtest("a shim resolves its output and execs the real tool"):
        out = machine.succeed("uv --version")
        assert "uv" in out, f"uv --version did not run the real tool: {out!r}"
  '';
}
