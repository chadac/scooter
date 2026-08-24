# Warm-store seed + clean-shutdown marker — the sandbox-image side of the warm PVC pool.
#
# Two systemd units on the overlay upper (/nix/.scooter-rw), both no-ops in a normal
# conversation unless triggered:
#
#   1. scooter-store-clean-marker — writes `<upper>/.clean-shutdown` (image tag + time) on
#      GRACEFUL stop, and REMOVES it at boot. The warm-store controller returns a claimed
#      PVC to the pool (relabel `ready`, carrying the agent's installs) IFF this marker is
#      present at return — positive proof the overlay quiesced cleanly (a SIGKILL/crash
#      leaves no marker → the controller discards the PVC). No nix-specific repair needed:
#      suspend SIGTERMs systemd → graceful drain, and the state/ sqlite DB is
#      transaction-atomic. See todo/done/WARM_STORE_PVC_MANAGER.md.
#
#   2. scooter-warm-store-seed — the WARM JOB producer. Runs ONLY when the warm Job
#      requests it (a `<upper>/.warm-request` file the Job's init writes, carrying the
#      golden Nix expr). Builds the golden expr into the overlay (lands in upper/,
#      registered in state/), writes the clean marker, then powers off so the Job
#      completes and the controller relabels the PVC `ready`. Gated so it NEVER fires in a
#      real conversation (no .warm-request there).
#
# Lives in modules/sandbox-os (in the image + nixosTest-visible), NOT pkgs/sandbox-os.

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.warmStoreSeed;
  upper = config.programs.overlayStore.upperPath;   # /nix/.scooter-rw
  marker = "${upper}/.clean-shutdown";
  request = "${upper}/.warm-request";               # golden expr, written by the warm Job
in
{
  options.programs.warmStoreSeed = {
    enable = lib.mkEnableOption "the warm-store clean-shutdown marker + warm-seed units";
  };

  # On by default whenever the overlay store is on (they're inert without a warm request /
  # only matter to the pool controller). Keep an explicit toggle for nixosTests.
  # NOTE: `||` (boolean or), NOT `cfg.enable or …` — the latter is Nix's attr-default
  # keyword (`attr or fallback`), which returns cfg.enable (false) verbatim and never
  # consults the fallback. That bug left the units out of the image entirely.
  config = lib.mkIf (cfg.enable || config.programs.overlayStore.enable) {
    # --- clean-shutdown marker (every graceful stop) -----------------------
    systemd.services.scooter-store-clean-marker = {
      description = "Write the overlay clean-shutdown marker on graceful stop (warm-pool return signal)";
      # Order after the overlay is up; a stop is graceful iff systemd runs ExecStop.
      after = [ "overlay-store-setup.service" ];
      wantedBy = [ "multi-user.target" ];
      # RemainAfterExit so the unit is "active" for its whole lifetime and ExecStop fires
      # on shutdown/suspend (SIGTERM → systemd stops units → this ExecStop runs).
      path = [ pkgs.coreutils ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        # At START (boot/claim): the volume is freshly (re)mounted — any prior marker is
        # stale for THIS session. Remove it so a marker only ever reflects a clean stop of
        # the CURRENT session (a crash then leaves NO marker → the controller discards).
        ExecStart = "${pkgs.coreutils}/bin/rm -f ${marker}";
        # At STOP (graceful only): stamp the marker with the image tag + time. A SIGKILL
        # skips ExecStop → no marker → unclean.
        ExecStop = pkgs.writeShellScript "scooter-store-clean-marker-stop" ''
          set -eu
          # Best-effort: never let this block shutdown.
          tag="''${SCOOTER_IMAGE_TAG:-unknown}"
          printf '{"tag":"%s","stoppedAt":"%s"}\n' "$tag" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ${marker} || true
        '';
      };
    };

    # --- warm-seed (warm Job only) -----------------------------------------
    systemd.services.scooter-warm-store-seed = {
      description = "Warm the overlay upper with the golden Nix expr, then power off (warm Job producer)";
      after = [ "overlay-store-setup.service" "nix-daemon.socket" "scooter-store-clean-marker.service" ];
      requires = [ "overlay-store-setup.service" ];
      wantedBy = [ "multi-user.target" ];
      # ONLY when the warm Job asked for it (the request file carries the golden expr).
      # Absent in a real conversation → this unit is skipped entirely.
      unitConfig.ConditionPathExists = request;
      path = [ pkgs.coreutils config.nix.package ];
      serviceConfig = {
        Type = "oneshot";
        # A warm failure must not leave a half-populated PVC labeled ready: on failure the
        # Job fails (backoffLimit) and the controller never relabels it → it's GC'd.
        ExecStart = pkgs.writeShellScript "scooter-warm-store-seed" ''
          set -eu
          expr=$(cat ${request})
          echo "warm-store: seeding golden expr: $expr"
          # Build the golden expr through the overlay store → lands in upper/, registered in
          # state/. `nix build --no-link` realises + registers the closure; the pool payoff is
          # the closure being PRESENT + valid, not on any profile. `eval` so the request can be
          # EITHER a space-separated list of flake installables (nixpkgs#awscli2 nixpkgs#nodejs)
          # OR a quoted `--expr '<nix>'` form — both word-split correctly under eval.
          eval "nix build --no-link --print-build-logs $expr"
          echo "warm-store: seed complete"
        '';
        # After a successful seed: stamp the clean marker (so the fresh PVC returns as a
        # valid `ready` volume), then bring the system DOWN with exit code 0 so the warm
        # Job's pod terminates SUCCESSFULLY. `systemctl exit 0` (container-aware) makes PID 1
        # exit 0 — a plain `poweroff` exits with systemd's shutdown code, which k8s counts as
        # a pod FAILURE (BackoffLimitExceeded even though the warm succeeded). The graceful
        # stop still runs scooter-store-clean-marker's ExecStop; we stamp here too as a
        # belt-and-suspenders so the marker is present regardless of unit stop ordering.
        ExecStartPost = [
          (pkgs.writeShellScript "scooter-warm-seed-finish" ''
            set -eu
            tag="''${SCOOTER_IMAGE_TAG:-unknown}"
            printf '{"tag":"%s","warmedAt":"%s"}\n' "$tag" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ${marker} || true
            rm -f ${request} || true
          '')
          "${pkgs.systemd}/bin/systemctl exit 0"
        ];
      };
    };
  };
}
