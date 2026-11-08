# The sandbox-image side of the warm PVC pool: two systemd units on the overlay
# upper. scooter-store-clean-marker writes `<upper>/.clean-shutdown` on graceful
# stop and removes it at boot, and the warm-store controller returns a PVC to the
# pool only when that marker is present. scooter-warm-store-seed runs only when
# the warm Job writes `<upper>/.warm-request`, builds the golden expr into the
# overlay, stamps the marker and powers off.

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.warmStoreSeed;
  upper = config.programs.overlayStore.upperPath;
  marker = "${upper}/.clean-shutdown";
  request = "${upper}/.warm-request";               # golden expr, written by the warm Job
  golden = "${upper}/state/gcroots/scooter-golden";   # kept across owners, unlike gcroots/auto
  gc = config.programs.overlayStore.gc;
  # The controller wipes volumes whose recorded size exceeds the PVC.
  writeMarker = field: pkgs.writeShellScript "scooter-store-marker" ''
    tag="''${SCOOTER_IMAGE_TAG:-unknown}"
    bytes=${if gc.enable then "$(${gc.package}/bin/scooter-store size 2>/dev/null || echo 0)" else "0"}
    printf '{"tag":"%s","${field}":"%s","upperBytes":%s}\n' "$tag" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "''${bytes:-0}" > ${marker}
  '';
in
{
  options.programs.warmStoreSeed = {
    enable = lib.mkEnableOption "the warm-store clean-shutdown marker + warm-seed units";
  };

  # On by default whenever the overlay store is on, with an explicit toggle for nixosTests.
  config = lib.mkIf (cfg.enable || config.programs.overlayStore.enable) {
    # --- clean-shutdown marker (every graceful stop) -----------------------
    systemd.services.scooter-store-clean-marker = {
      description = "Write the overlay clean-shutdown marker on graceful stop (warm-pool return signal)";
      after = [ "overlay-store-setup.service" ];
      wantedBy = [ "multi-user.target" ];
      # RemainAfterExit keeps the unit active for its whole lifetime so ExecStop fires on shutdown.
      path = [ pkgs.coreutils ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        # A prior marker is stale for this session, so only a clean stop of the current session leaves one.
        ExecStart = "${pkgs.coreutils}/bin/rm -f ${marker}";
        # A SIGKILL skips ExecStop, so no marker means an unclean stop.
        ExecStop = pkgs.writeShellScript "scooter-store-clean-marker-stop" ''
          # Best-effort: never block shutdown.
          ${writeMarker "stoppedAt"} || true
        '';
      };
    };

    # --- warm-seed (warm Job only) -----------------------------------------
    systemd.services.scooter-warm-store-seed = {
      description = "Warm the overlay upper with the golden Nix expr, then power off (warm Job producer)";
      after = [ "overlay-store-setup.service" "nix-daemon.socket" "scooter-store-clean-marker.service" ];
      requires = [ "overlay-store-setup.service" ];
      wantedBy = [ "multi-user.target" ];
      # The request file exists only in a warm Job, so a real conversation skips this unit.
      unitConfig = {
        ConditionPathExists = request;
        # A failed seed ends the pod, so the Job fails fast instead of idling.
        FailureAction = "exit";
      };
      path = [ pkgs.coreutils config.nix.package ];
      serviceConfig = {
        Type = "oneshot";
        # A failure fails the Job, so the controller never relabels a half-populated PVC ready.
        ExecStart = pkgs.writeShellScript "scooter-warm-store-seed" ''
          set -eu
          expr=$(cat ${request})
          # An empty expr is a minimal warm: no build, just the clean marker.
          if [ -z "$expr" ]; then echo "warm-store: empty golden expr, minimal warm"; exit 0; fi
          echo "warm-store: seeding golden expr: $expr"
          # `eval` lets the request be either a list of flake installables or a quoted `--expr '<nix>'` form.
          # These links root the seed for every later owner.
          rm -rf ${golden}
          mkdir -p ${golden}
          eval "nix build --out-link ${golden}/result --print-build-logs $expr"
          echo "warm-store: seed complete"
        '';
        # Stamp the marker here regardless of unit stop ordering, then `systemctl exit 0` so PID 1 exits 0 and k8s counts the pod as succeeded.
        ExecStartPost = [
          (pkgs.writeShellScript "scooter-warm-seed-finish" ''
            set -eu
            ${writeMarker "warmedAt"} || true
            rm -f ${request} || true
          '')
          "${pkgs.systemd}/bin/systemctl exit 0"
        ];
      };
    };
  };
}
