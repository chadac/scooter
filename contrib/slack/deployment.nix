# slack's DEPLOYMENT half. Gated on contribs.slack.enable; why: #599, #711.
{ config, lib, ... }:

let
  ccfg = config.contribs.slack;
in
{
  config = lib.mkIf (config.scooter.broker.enable && ccfg.enable) {
    scooter.broker.extraEnv = [
      {
        name = "SLACK_BOT_TOKEN";
        valueFrom.secretKeyRef = {
          name = ccfg.botTokenSecret.name;
          key = ccfg.botTokenSecret.key;
        };
      }
    ];
  };
}
