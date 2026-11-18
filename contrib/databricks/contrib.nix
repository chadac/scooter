# One provider per workspace (databricks-<name>); ./deployment.nix mounts the tokens.
{ lib, ... }:
let
  inherit (lib) mkOption types;
in
{
  contribs.databricks = { config, ... }: {
    options = {
      workspaces = mkOption {
        type = types.attrsOf (types.submodule {
          options.host = mkOption {
            type = types.str;
            example = "https://acme-dev.cloud.databricks.com";
            description = "The workspace URL.";
          };
        });
        default = { };
        example = { dev.host = "https://acme-dev.cloud.databricks.com"; };
        description = ''
          Workspaces by name (lowercase, [a-z0-9-]). Each mounts as provider
          `databricks-<name>`; its token is key `<name>` of tokensSecret.
        '';
      };
      tokensSecret = mkOption {
        type = types.str;
        default = "databricks-tokens";
        description = ''
          Secret in the broker namespace holding one access token per workspace,
          mounted as files. Optional: a missing key sends no token (401).
        '';
      };
    };

    config = {
      src = ./.;
      services.broker = {
        enable = true;
        env = {
          DATABRICKS_WORKSPACES = builtins.toJSON (lib.mapAttrs (_: w: w.host) config.workspaces);
          DATABRICKS_TOKENS_DIR = "/var/run/scooter/databricks";
        };
      };
      skills."scooter-databricks.md" = ./skills/scooter-databricks.md;
    };
  };
}
