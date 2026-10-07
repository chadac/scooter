{ lib, ... }:
let
  inherit (lib) mkOption types;
in
{
  contribs.grafana = {
    options = {
      url = mkOption {
        type = types.str;
        default = "";
        example = "https://myorg.grafana.net";
        description = "Base URL of the Grafana stack. Upstream for /grafana/*; a trailing slash is stripped.";
      };
      tokenSecret = mkOption {
        default = { };
        type = types.submodule {
          options = {
            name = mkOption { type = types.str; default = ""; description = "Secret name (in the broker namespace)."; };
            key = mkOption { type = types.str; default = "GRAFANA_TOKEN"; description = "Secret key holding the Grafana service-account token."; };
          };
        };
        description = ''
          Secret holding a Grafana service-account token. Injected as GRAFANA_TOKEN;
          the secret must exist in the broker namespace. Scope it read-only
          (logs:read / traces:read / metrics:read) when you mint it.

          The broker proxies /grafana/* to `url` with the token attached, so the agent
          can query dashboards and datasources — and through Grafana's datasource
          proxy, the Prometheus and Loki behind them — without ever seeing the token.
          The routes mount iff BOTH `url` and this secret resolve; otherwise the
          /grafana/* routes never mount and calls 404 rather than failing loudly.
        '';
      };
    };

    config = {
      src = ./.;
      services.broker.enable = true;
      skills."scooter-grafana.md" = ./skills/scooter-grafana.md;
    };
  };
}
