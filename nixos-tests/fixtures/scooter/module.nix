# A fixture `.scooter/module.nix` — stands in for a deployment's injected NixOS
# module (e.g. a deployment's, declaring example-review). Proves the runtime-converge
# mechanism applies, from a mounted module:
#   - a TOOL the module declares itself (the example-review pattern: no central
#     registry, no enumeration), AND
#   - a systemd service (full NixOS-module power, not just packages).
#
# A real NixOS module: { config, pkgs, lib, ... }: { ... }.
#
# The tool is EAGER now. The stub overlay covers the sandbox's own declared tools
# (modules/sandbox-os/stubs.nix), but an injected module naming an arbitrary
# package gets the real thing, so a heavy tool is built during the switch. See the
# follow-up note in skills/scooter-env.md.
{ config, pkgs, lib, ... }:
{
  # The module DECLARES its own tool — exactly how a deployment's module declares
  # example-review. No central registry, no enumeration.
  environment.systemPackages = [
    (pkgs.writeShellScriptBin "scooter-demo" ''exec ${pkgs.hello}/bin/hello "$@"'')
  ];

  # A systemd service the injected module adds — proves full NixOS-module power
  # (not just packages) survives the runtime switch.
  systemd.services.scooter-demo-service = {
    description = "Injected demo service (proves .scooter module services apply)";
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "${pkgs.coreutils}/bin/true";
    };
  };
}
