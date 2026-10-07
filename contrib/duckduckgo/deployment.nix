# duckduckgo's DEPLOYMENT half. Gated on contribs.duckduckgo.enable; why: #599, #711.
{ config, lib, ... }:

let
  ccfg = config.contribs.duckduckgo;
in
{
  config = lib.mkIf (config.scooter.broker.enable && ccfg.enable) {
    scooter.broker.extraEnv = [
      { name = "DUCKDUCKGO_ENABLED"; value = "true"; }
    ];
  };
}
