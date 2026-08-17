# nixosTest: config/custom (the agent's own modules) is layered onto config/root by the switch.
#
# config/custom is the AGENT-EDITABLE layer — the agent authors modules there (on the workspace
# PVC), then scooter-rebuild switches. The flake imports ./custom AFTER ./modules/sandbox/root,
# so custom EXTENDS/OVERRIDES the base but can't break it. This test proves the layering: a
# custom module that turns the sample service ON is picked up by the firstboot build+switch,
# even though config/root ships it OFF.
#
# Same offline model as bootstrap-config-root: build sandboxSystem OUTSIDE + seed its closure so
# the in-VM build is a cache-hit. The difference is a NON-empty config/custom.
#
# RED until: config/custom layering is wired (the flake imports ./custom + the assembler lets a
# custom module be supplied for the test).

{ pkgs, lib, bootstrapModule }:

let
  nixpkgsSrc = pkgs.runCommand "nixpkgs-src" { } ''cp -r ${pkgs.path} $out'';

  # A CUSTOM module (what the agent would author in config/custom/default.nix): turn the sample
  # service ON at a distinctive port. config/root ships it OFF, so if the switch picks this up,
  # the service is running → custom was layered.
  customModule = ''
    { lib, ... }: {
      services.sampleDevService = { enable = lib.mkForce true; port = 8911; };
    }
  '';

  # config/root WITH this custom module baked into config/custom (models the agent having
  # authored it on the workspace PVC before the switch).
  configRoot = (pkgs.callPackage ../pkgs/sandbox/config-root {
    nixpkgs = nixpkgsSrc;
  }).override { inherit customModule; };  # IMPL: assembler must accept a customModule override

  sandboxSystem = (builtins.getFlake "path:${configRoot}").sandboxSystem;
  sandboxToplevel = sandboxSystem.config.system.build.toplevel;
in
pkgs.testers.runNixOSTest {
  name = "bootstrap-config-custom";

  nodes.machine = { config, lib, pkgs, ... }: {
    imports = [ bootstrapModule ];
    programs.scooterFirstboot.enable = true;
    programs.scooterFirstboot.detach = lib.mkForce false;
    programs.overlayStore.enable = lib.mkForce false;

    systemd.tmpfiles.rules = [ "L+ /etc/scooter/config - - - - ${configRoot}" ];
    system.extraDependencies = [ nixpkgsSrc configRoot sandboxToplevel ];
  };

  testScript = ''
    machine.wait_for_unit("default.target")
    (status, _) = machine.systemctl("is-active scooter-firstboot.service")
    if status != 0:
        print(machine.execute("journalctl -u scooter-firstboot.service --no-pager")[1])
        print(machine.execute("cat /run/scooter/env-switch/log 2>&1")[1])
    machine.wait_for_unit("scooter-firstboot.service")

    # The switch built config/root WITH config/custom → the custom module's service is INSTALLED
    # (config/root ships it OFF, so its presence proves custom was layered on top).
    current = machine.succeed("readlink -f /run/current-system").strip()
    assert current == "${sandboxToplevel}", f"switch target mismatch: {current!r}"
    # The custom-enabled service exists + is wantedBy multi-user (config/root has it disabled).
    machine.succeed("systemctl cat sample-dev-service.service >/dev/null")
    machine.succeed("systemctl start sample-dev-service.service")
    machine.wait_for_open_port(8911)   # the CUSTOM port — proves custom's config won
  '';
}
