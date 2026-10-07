# jira's DEPLOYMENT half. Moved out of modules/broker.nix; why: #599, #711.
{ config, lib, ... }:

let
  inherit (lib) mkOption types;
  bcfg = config.scooter.broker;
in
{
  # Stays `jiraSiteUrl`, not `jira.siteUrl`: renaming it is a breaking change for
  # deployers and this move is meant to be a no-op.
  options.scooter.broker.jiraSiteUrl = mkOption {
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

  # No `enable`: the option IS the gate, matching the original.
  config = lib.mkIf (bcfg.enable && bcfg.jiraSiteUrl != "") {
    scooter.broker.extraEnv = [
      { name = "JIRA_SITE_URL"; value = bcfg.jiraSiteUrl; }
    ];
  };
}
