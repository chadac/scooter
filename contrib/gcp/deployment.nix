# gcp's deployment half: env that points gcloud and terraform in every sandbox pod at the forge proxy.
{ config, lib, ... }:

let
  ccfg = config.contribs.gcp;
  project = lib.optionals (ccfg.project != "") [
    { name = "CLOUDSDK_CORE_PROJECT"; value = ccfg.project; }
    { name = "GOOGLE_CLOUD_PROJECT"; value = ccfg.project; }
  ];
in
{
  # Placeholder tokens; the forge proxy swaps in the real one.
  config.scooter.sandboxPod.extraEnv = lib.mkIf (config.scooter.broker.enable && ccfg.enable) ([
    # The file is ./sandbox.nix's; gcloud has no plain-token setting.
    { name = "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE"; value = "/etc/scooter/gcp/access-token"; }
    { name = "GOOGLE_OAUTH_ACCESS_TOKEN"; value = "scooter-forge-proxy"; }
    # gsutil and bq ship their own CA list, which lacks the forge CA.
    { name = "CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE"; value = "/etc/ssl/certs/ca-certificates.crt"; }
  ] ++ project);
}
