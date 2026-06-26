# services.sampleDevService — the PoC sample systemd service.
#
# A minimal service proving the systemd path end-to-end: it reaches `active`,
# opens a TCP port, and the agent can `systemctl start/stop` it. Stands in for a
# real collaborative service (Jupyter etc.) which reuses the same path later.
#
# STAGE 3 (red-first): option schema is real; the systemd.services definition is
# NOT implemented yet, so the service nixosTest fails until Stage 5.

{ config, lib, pkgs, ... }:

let
  cfg = config.services.sampleDevService;
in
{
  options.services.sampleDevService = {
    enable = lib.mkEnableOption "the PoC sample dev service (proves the systemd path)";

    port = lib.mkOption {
      type = lib.types.port;
      default = 8888;
      description = "TCP port the sample service listens on.";
    };
  };

  # STAGE 5 will implement: a tiny HTTP listener as a systemd unit on cfg.port.
  config = lib.mkIf cfg.enable {
    # TODO(stage5): systemd.services.sample-dev-service = { ... };
  };
}
