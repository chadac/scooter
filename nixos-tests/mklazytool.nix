# nixosTest: `mkLazyTool` is usable DIRECTLY in any module (the refactor's point)
# — a module declares its own lazy tool inline via the `{ mkLazyTool, ... }`
# argument, including MULTIPLE commands from one package. This is what lets a
# deployment's own `.scooter/module.nix` ship a tool without a central registry
# or an image rebuild.
#
# Proves: a module that calls mkLazyTool puts ALL its `commands` on PATH, and
# they lazily resolve the package from the pinned nixpkgs on first use. Offline
# (the package is pre-seeded; pin -> the test's nixpkgs source).

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-mklazytool";

  nodes.machine = { config, pkgs, lib, mkLazyTool, ... }: {
    imports = [ "${sandboxModule}/lazy-tools.nix" "${sandboxModule}/nix-config.nix" ];

    programs.lazyTools = {
      enable = true;
      defaultNixpkgs = "path:${pkgs.path}";
    };
    devEnvNix = { enable = true; nixpkgs = lib.mkForce "path:${pkgs.path}"; };

    # The refactor's payload: a module declares its OWN lazy tool inline, with
    # several commands from one package (here: hello, exposed as `hello` AND an
    # alias `hi`, both resolving nixpkgs#hello lazily).
    environment.systemPackages = [
      (mkLazyTool {
        package = "hello";
        commands = [ "hello" "hi" ];
        bin = "hello";
      })
    ];

    system.extraDependencies = [ pkgs.path pkgs.hello ];
    nix.settings.experimental-features = [ "nix-command" "flakes" ];
    # The in-VM resolve copies nixpkgs around; give it headroom.
    virtualisation.diskSize = 6144;
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    # BOTH commands the module declared are on PATH.
    machine.succeed("command -v hello")
    machine.succeed("command -v hi")

    # Each lazily resolves nixpkgs#hello on first call and runs it.
    assert "Hello, world!" in machine.succeed("hello")
    assert "Hello, world!" in machine.succeed("hi")
  '';
}
