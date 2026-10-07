# slack's DEPLOYMENT half. Moved out of modules/broker.nix; why: #599, #711.
{ config, lib, ... }:

let
  inherit (lib) mkOption types;
  bcfg = config.scooter.broker;
  scfg = bcfg.slack;
in
{
  options.scooter.broker.slack = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "Enable the Slack provider (http-proxy to slack.com/api with the bot token injected).";
    };
    botTokenSecret = mkOption {
      type = types.submodule {
        options = {
          name = mkOption { type = types.str; description = "Secret name (in the broker namespace)."; };
          key = mkOption { type = types.str; default = "SLACK_BOT_TOKEN"; description = "Secret key holding the Slack bot token."; };
        };
      };
      description = "Secret holding the Slack bot token (xoxb-…). Injected as SLACK_BOT_TOKEN. The secret must exist in the broker namespace.";
    };
  };

  # Needs the broker too: without it there is no container to inject env into.
  config = lib.mkIf (bcfg.enable && scfg.enable) {
    scooter.broker.extraEnv = [
      {
        name = "SLACK_BOT_TOKEN";
        valueFrom.secretKeyRef = {
          name = scfg.botTokenSecret.name;
          key = scfg.botTokenSecret.key;
        };
      }
    ];
  };
}
