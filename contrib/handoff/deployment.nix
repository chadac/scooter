# handoff's deployment half: the broker may spawn and read owned conversations through
# the router, Approve/Deny reach the broker, and links get a UI origin.
#
# `{ config, lib, ... }` only, and nothing built: an external deployer imports
# modules/platform.nix with no `pkgs`, so forcing a package here is an eval error.
{ config, lib, ... }:

let
  cfg = config.scooter;
  ccfg = config.contribs.handoff;
  publicBaseUrl =
    if ccfg.publicBaseUrl != "" then ccfg.publicBaseUrl
    else if cfg.ingress.host != "" then "https://${cfg.ingress.host}"
    else "";
in
{
  config = lib.mkMerge [
    (lib.mkIf ccfg.enable {
      scooter.conversationController.spawners = [ "agent-broker" ];
      scooter.conversationController.readers = [ "agent-broker" ];
    })
    (lib.mkIf (ccfg.enable && cfg.broker.enable) {
      scooter.approvals.handoff = {
        brokerPrefix = "/handoff/spawns";
        pendingPath = "/handoff/spawns/pending";
      };
    })
    # Rendered by modules/contrib-env.nix with the rest of the contrib env.
    {
      contribs.handoff.services.broker.env.HANDOFF_PUBLIC_BASE_URL = lib.mkIf (publicBaseUrl != "") publicBaseUrl;
    }
  ];
}
