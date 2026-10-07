# airtable's DEPLOYMENT half. Moved out of modules/broker.nix; why: #599, #711.
{ config, lib, ... }:

let
  inherit (lib) mkOption types;
  bcfg = config.scooter.broker;
  scfg = bcfg.airtable;
in
{
  options.scooter.broker.airtable = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "Enable the Airtable provider (http-proxy to api.airtable.com with a personal access token injected).";
    };
    tokenSecret = mkOption {
      type = types.submodule {
        options = {
          name = mkOption { type = types.str; description = "Secret name (in the broker namespace)."; };
          key = mkOption { type = types.str; default = "AIRTABLE_TOKEN"; description = "Secret key holding the Airtable personal access token."; };
        };
      };
      description = "Secret holding an Airtable personal access token (pat…). Injected as AIRTABLE_TOKEN. The secret must exist in the broker namespace.";
    };
  };

  # Needs the broker too: without it there is no container to inject env into.
  config = lib.mkIf (bcfg.enable && scfg.enable) {
    scooter.broker.extraEnv = [
      {
        name = "AIRTABLE_TOKEN";
        valueFrom.secretKeyRef = {
          name = scfg.tokenSecret.name;
          key = scfg.tokenSecret.key;
        };
      }
    ];
  };
}
