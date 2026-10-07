# jira's DEPLOYMENT half. Moved out of modules/broker.nix; why: #599, #711.
{ config, lib, ... }:

let
  inherit (lib) mkOption types;
  bcfg = config.scooter.broker;
  scfg = bcfg.jira;
in
{
  options.scooter.broker.jira = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Enable the Jira provider: an http-proxy to a Jira site with the API token
        injected, so the agent can read and write issues without seeing it.
      '';
    };
    siteUrl = mkOption {
      type = types.str;
      default = "";
      example = "https://acme.atlassian.net";
      description = ''
        The Jira SITE base URL, used to build a human /browse/{KEY} link when the
        broker auto-links an issue an agent creates via the Jira proxy (the
        create-issue API response carries no human URL). Empty -> auto-link uses
        the API `self` URL instead.
      '';
    };
  };

  # Needs the broker too: without it there is no container to inject env into.
  config = lib.mkIf (bcfg.enable && scfg.enable) {
    scooter.broker.extraEnv =
      lib.optional (scfg.siteUrl != "") { name = "JIRA_SITE_URL"; value = scfg.siteUrl; };
  };
}
