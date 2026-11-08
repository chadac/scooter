# Contrib approvals: each enabled contrib declaring `approvals` gets its agent-host
# route, at the /<name>/approvals that scooter_broker_lib.approvals mounts. A contrib
# whose routes live elsewhere sets its own row, which wins.

{ config, lib, ... }:

let
  raising = lib.filterAttrs (_: c: c.enable && c.approvals != null) config.contribs;
in
{
  config.scooter.approvals = lib.mkIf config.scooter.broker.enable (lib.mapAttrs
    (name: _: lib.mapAttrs (_: lib.mkDefault) {
      brokerPrefix = "/${name}/approvals";
      pendingPath = "/${name}/approvals/pending";
    })
    raising);
}
