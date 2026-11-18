# databricks's deployment half: mount the tokens Secret into the broker, and
# tell the sandbox the workspaces (with a placeholder token the forge proxy replaces).
{ config, lib, ... }:

let
  ccfg = config.contribs.databricks;
  on = config.scooter.broker.enable && ccfg.enable && ccfg.workspaces != { };
in
{
  config = lib.mkIf on {
    scooter.broker.extraVolumes = [
      { name = "databricks-tokens"; secret = { secretName = ccfg.tokensSecret; optional = true; }; }
    ];
    scooter.broker.extraVolumeMounts = [
      { name = "databricks-tokens"; mountPath = "/var/run/scooter/databricks"; readOnly = true; }
    ];
    scooter.sandboxPod.extraEnv = [
      { name = "DATABRICKS_WORKSPACES"; value = builtins.toJSON (lib.mapAttrs (_: w: w.host) ccfg.workspaces); }
      { name = "DATABRICKS_TOKEN"; value = "scooter-forge-proxy"; }
    ];
  };
}
