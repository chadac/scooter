{ lib, ... }:
{
  contribs.airtable = {
    options.tokenSecret = lib.mkOption {
      type = lib.types.submodule {
        options = {
          name = lib.mkOption { type = lib.types.str; description = "Secret name (in the broker namespace)."; };
          key = lib.mkOption { type = lib.types.str; default = "AIRTABLE_TOKEN"; description = "Secret key holding the Airtable personal access token."; };
        };
      };
      description = ''
        Secret holding an Airtable personal access token (pat…). Injected as
        AIRTABLE_TOKEN. The secret must exist in the broker namespace.

        Enabling this contrib runs the Airtable provider: an http-proxy to
        api.airtable.com with the token injected.
      '';
    };

    config = {
      src = ./.;
      services.broker.enable = true;
      skills."scooter-airtable.md" = ./skills/scooter-airtable.md;
    };
  };
}
