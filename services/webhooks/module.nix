{ config, lib, buildPkgs, ... }:

let
  cfg = config.scooter.config;
in
{
  scooter.packages = {
    # Without contribs: what the contribs build and test against.
    scooter-webhooks-base = lib.mkDefault (buildPkgs.callPackage ./. { });
    scooter-webhooks = lib.mkDefault (buildPkgs.callPackage ./. { contribs = cfg.contribs.webhooks; });
  };

  scooter.images.agent-webhooks = {
    package = lib.mkDefault (import ./image.nix {
      pkgs = buildPkgs;
      inherit (cfg) n2c imageLayers;
      webhooks = buildPkgs.scooter-webhooks;
    });
    attr = "webhooks-image";
    refKey = "webhooks";
    imageless.mountPoints = [ "/data" ];
  };
}
