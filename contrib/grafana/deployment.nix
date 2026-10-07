# grafana's DEPLOYMENT half. Moved out of modules/broker.nix; why: #599, #711.
{ config, lib, ... }:

let
  inherit (lib) mkOption types;
  bcfg = config.scooter.broker;
  scfg = bcfg.grafana;
in
{
  options.scooter.broker.grafana = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Enable the Grafana provider: an http-proxy to a Grafana stack with a
        service-account token injected.

        The broker proxies /grafana/* to `url` with the token attached, so the agent
        can query dashboards and datasources — and through Grafana's datasource
        proxy, the Prometheus and Loki behind them — without ever seeing the token.

        Mounts iff BOTH `url` and `tokenSecret` resolve; otherwise the /grafana/*
        routes never mount and calls 404 rather than failing loudly.
      '';
    };
    url = mkOption {
      type = types.str;
      default = "";
      example = "https://myorg.grafana.net";
      description = "Base URL of the Grafana stack. Upstream for /grafana/*; a trailing slash is stripped.";
    };
    tokenSecret = mkOption {
      type = types.submodule {
        options = {
          name = mkOption { type = types.str; description = "Secret name (in the broker namespace)."; };
          key = mkOption { type = types.str; default = "GRAFANA_TOKEN"; description = "Secret key holding the Grafana service-account token."; };
        };
      };
      description = ''
        Secret holding a Grafana service-account token. Injected as GRAFANA_TOKEN;
        the secret must exist in the broker namespace. Scope it read-only
        (logs:read / traces:read / metrics:read) when you mint it.
      '';
    };
  };

  # Needs the broker too: without it there is no container to inject env into.
  config = lib.mkIf (bcfg.enable && scfg.enable) {
    scooter.broker.extraEnv = [
      { name = "GRAFANA_URL"; value = scfg.url; }
      {
        name = "GRAFANA_TOKEN";
        valueFrom.secretKeyRef = {
          name = scfg.tokenSecret.name;
          key = scfg.tokenSecret.key;
        };
      }
    ];
  };
}
