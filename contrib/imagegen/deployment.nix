# imagegen's deployment half, reading contribs.imagegen.
#
# `{ config, lib, ... }` only, and nothing built: an external deployer imports
# modules/platform.nix with no `pkgs`, so forcing a package here is an eval error.
{ config, lib, ... }:

let
  ccfg = config.contribs.imagegen;
  bedrock = ccfg.backends.bedrock;
in
{
  config = lib.mkIf (config.scooter.broker.enable && ccfg.enable && bedrock.enable) {
    # IRSA: the broker pod calls bedrock-runtime as itself, no secret of ours to hold.
    scooter.broker.serviceAccountAnnotations = lib.optionalAttrs ((bedrock.roleArn or "") != "") {
      "eks.amazonaws.com/role-arn" = bedrock.roleArn;
    };
  };
}
