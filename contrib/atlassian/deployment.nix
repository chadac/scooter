# atlassian's deployment half: where the sandbox's curl and scripts find the site.
{ config, lib, ... }:

let
  ccfg = config.contribs.atlassian;
  products = lib.optional ccfg.jira.enable "jira" ++ lib.optional ccfg.confluence.enable "confluence";
in
{
  # No token: the forge proxy injects its own.
  config.scooter.sandboxPod.extraEnv = lib.mkIf (config.scooter.broker.enable && ccfg.enable) (
    [ { name = "ATLASSIAN_PRODUCTS"; value = lib.concatStringsSep " " products; } ]
    ++ lib.optional (ccfg.cloudId != "") { name = "ATLASSIAN_CLOUD_ID"; value = ccfg.cloudId; }
    ++ lib.optional (ccfg.siteUrl != "") { name = "ATLASSIAN_SITE_URL"; value = ccfg.siteUrl; }
  );
}
