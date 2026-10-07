{ lib, ... }:
let
  inherit (lib) mkOption types;
in
{
  contribs.datadog = {
    options = {
      site = mkOption {
        type = types.str;
        default = "datadoghq.com";
        description = "Datadog site/region host suffix (datadoghq.com | datadoghq.eu | us3.datadoghq.com | us5.datadoghq.com | ap1.datadoghq.com | ddog-gov.com). Upstream is https://api.<site>.";
      };
      apiKeySecret = mkOption {
        type = types.submodule {
          options = {
            name = mkOption { type = types.str; description = "Secret name (in the broker namespace)."; };
            key = mkOption { type = types.str; default = "DATADOG_API_KEY"; description = "Secret key holding the Datadog API key."; };
          };
        };
        description = "Secret holding the Datadog API key. Injected as DATADOG_API_KEY. The secret must exist in the broker namespace.";
      };
      appKeySecret = mkOption {
        type = types.submodule {
          options = {
            name = mkOption { type = types.str; description = "Secret name (in the broker namespace)."; };
            key = mkOption { type = types.str; default = "DATADOG_APP_KEY"; description = "Secret key holding the Datadog application key."; };
          };
        };
        description = "Secret holding the Datadog application key. Injected as DATADOG_APP_KEY. The secret must exist in the broker namespace.";
      };
    };

    config = {
      src = ./.;
      services.broker.enable = true;
      skills."scooter-datadog.md" = ./skills/scooter-datadog.md;
    };
  };
}
