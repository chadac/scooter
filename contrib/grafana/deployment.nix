# grafana's DEPLOYMENT half. Gated on contribs.grafana.enable; why: #599, #711.
{ config, lib, ... }:

let
  ccfg = config.contribs.grafana;
in
{
  # Both env vars unset => the provider reports disabled and /grafana/* 404s.
  config = lib.mkIf (config.scooter.broker.enable && ccfg.enable) {
    scooter.broker.extraEnv = [
      { name = "GRAFANA_URL"; value = ccfg.url; }
      {
        name = "GRAFANA_TOKEN";
        valueFrom.secretKeyRef = {
          name = ccfg.tokenSecret.name;
          key = ccfg.tokenSecret.key;
        };
      }
    ];
  };
}
