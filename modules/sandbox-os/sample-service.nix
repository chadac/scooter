# services.sampleDevService — the PoC sample systemd service.
#
# A minimal service proving the systemd path end-to-end: it reaches `active`,
# opens a TCP port, and the agent can `systemctl start/stop` it. Stands in for a
# real collaborative service (Jupyter etc.) which reuses the same path later.

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

  config = lib.mkIf cfg.enable {
    # A tiny HTTP listener on cfg.port — Python's stdlib http.server, no app code
    # to ship. Enough to prove: reaches `active`, opens the port, responds, and
    # `systemctl start/stop` toggles it. Replace with a real unit (Jupyter, …)
    # later; the shape (a wanted-by-multi-user systemd unit) is the same.
    systemd.services.sample-dev-service = {
      description = "PoC sample dev service (HTTP on ${toString cfg.port})";
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        ExecStart = "${pkgs.python3}/bin/python3 -m http.server ${toString cfg.port} --bind 0.0.0.0";
        DynamicUser = true;
        Restart = "on-failure";
      };
    };
  };
}
