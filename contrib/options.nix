# The contrib schema: `contribs.<name>`, typed, with defaults.
#
# Importable on its own if you want the options without the contribs (nothing
# does yet; `all-modules.nix` is the usual entry point). Why: PR #585.
{ lib, config, python3Packages, scooterBrokerLib, scooterWebhooksLib, broker, webhooks, ... }:

{
  options.contribs = lib.mkOption {
    default = { };
    description = ''
      Every contrib, keyed by name. A contrib is a self-contained Python
      distribution that plugs into one or more Scooter services through entry
      points — see contrib/README.md.
    '';
    type = lib.types.attrsOf (lib.types.submoduleWith {
      # `shorthandOnlyDefinesConfig` stays at submoduleWith's default (false) so a
      # definition may use the strict module form and declare its OWN options. The
      # plain-attrset form still works: a definition with no `options`/`config`/
      # `imports` key is read as config.
      specialArgs = {
        inherit lib python3Packages scooterBrokerLib scooterWebhooksLib broker webhooks;
        # The parent config. A contrib's package list names another contrib
        # through the package set it is handed, but deploy-time options (when they
        # land) will want to read platform-wide config from here.
        scooter = config;
      };
      modules = [ ./submodule.nix ];
    });
  };
}
