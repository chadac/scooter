# apikeys deployment half: only webhooks may verify keys.
{ config, lib, ... }:

let
  cfg = config.scooter;
  on = config.contribs.apikeys.enable;
in
{
  config.contribs.apikeys.services = {
    broker.env.APIKEYS_VERIFIER_SERVICE_ACCOUNTS =
      lib.mkIf on "system:serviceaccount:${cfg.namespace}:agent-webhooks";
    # Only an enforcing router proves the X-Scooter-User webhooks sends.
    webhooks.env.BROKER_URL = lib.mkIf on (
      if cfg.auth.enforce then "http://agent-broker.${cfg.namespace}.svc.cluster.local:8080"
      else throw "contribs.apikeys needs scooter.auth.enforce = true");
  };
}
