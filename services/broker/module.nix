{ config, lib, buildPkgs, ... }:

let
  cfg = config.scooter.config;
in
{
  scooter.packages = {
    # Without contribs: what the contribs build and test against.
    scooter-broker-base = lib.mkDefault (buildPkgs.callPackage ./. { });
    scooter-broker = lib.mkDefault (buildPkgs.callPackage ./. { contribs = cfg.contribs.broker; });
  };

  scooter.images.agent-broker = {
    package = lib.mkDefault (import ./image.nix {
      pkgs = buildPkgs;
      inherit (cfg) n2c imageLayers;
      broker = buildPkgs.scooter-broker;
    });
    attr = "broker-image";
    refKey = "broker";
    imageless.mountPoints = [ "/etc/agent-broker" "/etc/scooter/forge-ca" ];
  };
}
