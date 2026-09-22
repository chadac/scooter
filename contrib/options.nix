# The contrib schema. Why: PR #585.
{ lib, config, python3Packages, scooterBrokerLib, scooterWebhooksLib, broker, webhooks, ... }:

{
  options.contribs = lib.mkOption {
    default = { };
    description = "Contribs by name — integration packages that plug into a service via entry points.";
    type = lib.types.attrsOf (lib.types.submoduleWith {
      # shorthandOnlyDefinesConfig stays false so a contrib may use the strict
      # module form and declare its own options.
      specialArgs = {
        inherit lib python3Packages scooterBrokerLib scooterWebhooksLib broker webhooks;
        scooter = config;
      };
      modules = [ ./submodule.nix ];
    });
  };
}
