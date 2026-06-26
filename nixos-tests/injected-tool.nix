# nixosTest: a DEPLOYMENT-INJECTED CLI tool (a lazyTools tool with `localFlake`)
# resolves from a MOUNTED local flake dir — the light injection mechanism — with
# NO flake ref. Proves: a tool defined in a deployment's `.scooter/` dir (a
# ConfigMap in prod) is on PATH as a lazy stub and, on first call, builds
# `path:<dir>#tool` from that mounted dir and execs it. Fast (it's just a package,
# not a system rebuild — unlike the parked runtime-converge path).
#
# A deployment ships its OWN real tool this way — e.g. example-review in the
# deployment repo's .scooter/ dir. THIS repo only proves the mechanism. See docs/SCOOTER_DIR_INJECTION.md.

{ pkgs, lib, sandboxModule }:

let
  # The fixture .scooter flake, with its nixpkgs input rewritten to the test's
  # OWN nixpkgs source (a path) so the in-VM `nix build path:<dir>#tool --impure`
  # resolves OFFLINE. (A real deployment pins nixpkgs in its own .scooter flake.)
  scooterDir = pkgs.runCommand "scooter-dir" { } ''
    cp -r ${../nixos-tests/fixtures/injected-tools} $out
    chmod -R +w $out
    substituteInPlace $out/flake.nix \
      --replace 'github:NixOS/nixpkgs' 'path:${pkgs.path}'
  '';

  # The built tool (built here so its closure can be pre-seeded for the offline
  # in-VM build). Built via the same nixpkgs the fixture's lock points at, so it
  # matches what the in-VM `nix build path:<dir>#injected-tool` produces.
  demoTool = pkgs.writeShellScriptBin "injected-tool" "echo injected-tool-from-mounted-dir-ok";
in
pkgs.testers.runNixOSTest {
  name = "dev-env-injected-tool";

  nodes.machine = { config, pkgs, lib, ... }: {
    imports = [ "${sandboxModule}/lazy-tools.nix" "${sandboxModule}/nix-config.nix" ];

    programs.lazyTools = {
      enable = true;
      defaultNixpkgs = "path:${pkgs.path}";
      tools.injected-tool = {
        package = "injected-tool";
        localFlake = "/etc/agent-sandbox/scooter";
      };
    };
    devEnvNix = { enable = true; nixpkgs = lib.mkForce "path:${pkgs.path}"; };

    # The mounted .scooter dir (locked flake), as a real directory. Pre-seed the
    # nixpkgs source + the built tool so the in-VM build is offline.
    systemd.tmpfiles.rules = [
      "C+ /etc/agent-sandbox/scooter 0755 root root - ${scooterDir}"
    ];
    system.extraDependencies = [ pkgs.path scooterDir demoTool ];

    nix.settings.experimental-features = [ "nix-command" "flakes" ];
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    # The injected tool is on PATH as a lazy stub.
    machine.succeed("command -v injected-tool")

    # First call: builds `path:/etc/agent-sandbox/scooter#injected-tool` from the
    # mounted dir (no flake ref) and runs it.
    out = machine.succeed("injected-tool")
    assert "injected-tool-from-mounted-dir-ok" in out, f"injected tool didn't run: {out!r}"

    # Memoized.
    machine.succeed("test -e /var/cache/lazy-tools/injected-tool")

    # If the .scooter dir is NOT mounted, the stub errors clearly.
    machine.succeed("rm -rf /etc/agent-sandbox/scooter /var/cache/lazy-tools/injected-tool")
    machine.fail("injected-tool")
  '';
}
