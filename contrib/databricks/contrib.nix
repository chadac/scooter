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
      grantHours = mkOption {
        type = types.numbers.nonnegative;
        default = 0;
        example = 4;
        description = ''
          Ask the conversation's owner before its first call to a workspace: an
          approval card grants read (GET/HEAD) or read-write access to that workspace
          for this many hours, listed in the Approvals tab to extend or revoke.
          0 sends every call without asking.
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

      # Its own database (contrib_databricks), for the grants.
      db = {
        enable = true;
        tables.databricks_grants = { };
      };

      services.broker = {
        enable = true;
        env = {
          DATABRICKS_WORKSPACES = builtins.toJSON (lib.mapAttrs (_: w: w.host) config.workspaces);
          DATABRICKS_TOKENS_DIR = "/var/run/scooter/databricks";
          DATABRICKS_GRANT_MINUTES = toString (builtins.floor (config.grantHours * 60));
        };
      };
      # Workspace access is approved in-conversation, at /databricks/approvals.
      approvals = lib.mkIf (config.grantHours > 0) { grants = true; };
      skills."scooter-databricks.md" = ./skills/scooter-databricks.md;
    };
  };
}
