{ config, lib, pkgs, ... }:
let cfg = config.services.markerService; in {
  options.services.markerService = {
    enable = lib.mkEnableOption "the config-custom test marker service";
    port = lib.mkOption { type = lib.types.port; default = 8080; };
  };
  config = lib.mkIf cfg.enable {
    systemd.services.marker = {
      wantedBy = [ "multi-user.target" ];
      serviceConfig.ExecStart =
        "${pkgs.python3}/bin/python3 -m http.server ${toString cfg.port} --bind 0.0.0.0";
    };
  };
}
