# airtable's DEPLOYMENT half. Gated on contribs.airtable.enable; why: #599, #711.
{ config, lib, ... }:

let
  ccfg = config.contribs.airtable;
in
{
  config = lib.mkIf (config.scooter.broker.enable && ccfg.enable) {
    scooter.broker.extraEnv = [
      {
        name = "AIRTABLE_TOKEN";
        valueFrom.secretKeyRef = {
          name = ccfg.tokenSecret.name;
          key = ccfg.tokenSecret.key;
        };
      }
    ];
  };
}
