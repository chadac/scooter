# A fixture `.scooter/module.nix` — stands in for a deployment's injected NixOS
# module (e.g. a deployment's, declaring example-review). Proves the runtime-converge
# mechanism applies, from a mounted module:
#   - a LAZY tool (via the mkLazyTool module arg — the example-review pattern: the
#     module DECLARES its own tool, no enumeration, and it stays lazy/light), AND
#   - a systemd service (full NixOS-module power, not just packages).
#
# A real NixOS module: { config, pkgs, lib, mkLazyTool, ... }: { ... }. mkLazyTool
# comes from the base config (programs.lazyTools exposes it as a module arg), so a
# deployment's module can use it without importing anything.
{ config, pkgs, lib, mkLazyTool, ... }:
{
  # The module DECLARES its own (lazy) tool — this is exactly how a deployment's
  # module declares example-review. `hello` materializes from the pinned nixpkgs on first
  # use; the module just put it on PATH. No central registry, no enumeration.
  environment.systemPackages = [
    (mkLazyTool { package = "hello"; commands = [ "scooter-demo" ]; bin = "hello"; })
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
