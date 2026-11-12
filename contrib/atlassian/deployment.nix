# atlassian's deployment half: the products and cloud id the sandbox calls.
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
  );
}
