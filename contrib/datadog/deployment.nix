# datadog's DEPLOYMENT half. Gated on contribs.datadog.enable; why: #599, #711.
{ config, lib, ... }:

let
  ccfg = config.contribs.datadog;
in
{
  config = lib.mkIf (config.scooter.broker.enable && ccfg.enable) {
    scooter.broker.extraEnv = [
      { name = "DATADOG_SITE"; value = ccfg.site; }
      {
        name = "DATADOG_API_KEY";
        valueFrom.secretKeyRef = {
          name = ccfg.apiKeySecret.name;
          key = ccfg.apiKeySecret.key;
        };
      }
      {
        name = "DATADOG_APP_KEY";
        valueFrom.secretKeyRef = {
          name = ccfg.appKeySecret.name;
          key = ccfg.appKeySecret.key;
        };
      }
    ];
  };
}
