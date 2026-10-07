# datadog's DEPLOYMENT half. Moved out of modules/broker.nix; why: #599, #711.
{ config, lib, ... }:

let
  inherit (lib) mkOption types;
  bcfg = config.scooter.broker;
  scfg = bcfg.datadog;
in
{
  options.scooter.broker.datadog = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "Enable the Datadog provider (http-proxy to api.<site> with the two keys injected).";
    };
    site = mkOption {
      type = types.str;
      default = "datadoghq.com";
      description = "Datadog site/region host suffix (datadoghq.com | datadoghq.eu | us3.datadoghq.com | us5.datadoghq.com | ap1.datadoghq.com | ddog-gov.com). Upstream is https://api.<site>.";
    };
    apiKeySecret = mkOption {
      type = types.submodule {
        options = {
          name = mkOption { type = types.str; description = "Secret name (in the broker namespace)."; };
          key = mkOption { type = types.str; default = "DATADOG_API_KEY"; description = "Secret key holding the Datadog API key."; };
        };
      };
      description = "Secret holding the Datadog API key. Injected as DATADOG_API_KEY. The secret must exist in the broker namespace.";
    };
    appKeySecret = mkOption {
      type = types.submodule {
        options = {
          name = mkOption { type = types.str; description = "Secret name (in the broker namespace)."; };
          key = mkOption { type = types.str; default = "DATADOG_APP_KEY"; description = "Secret key holding the Datadog application key."; };
        };
      };
      description = "Secret holding the Datadog application key. Injected as DATADOG_APP_KEY. The secret must exist in the broker namespace.";
    };
  };

  # Needs the broker too: without it there is no container to inject env into.
  config = lib.mkIf (bcfg.enable && scfg.enable) {
    scooter.broker.extraEnv = [
      { name = "DATADOG_SITE"; value = scfg.site; }
      {
        name = "DATADOG_API_KEY";
        valueFrom.secretKeyRef = {
          name = scfg.apiKeySecret.name;
          key = scfg.apiKeySecret.key;
        };
      }
      {
        name = "DATADOG_APP_KEY";
        valueFrom.secretKeyRef = {
          name = scfg.appKeySecret.name;
          key = scfg.appKeySecret.key;
        };
      }
    ];
  };
}
