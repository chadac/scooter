# jira's DEPLOYMENT half. Gated on contribs.jira.enable; why: #599, #711.
{ config, lib, ... }:

let
  ccfg = config.contribs.jira;
in
{
  config = lib.mkIf (config.scooter.broker.enable && ccfg.enable) {
    scooter.broker.extraEnv =
      lib.optional (ccfg.siteUrl != "") { name = "JIRA_SITE_URL"; value = ccfg.siteUrl; };
  };
}
