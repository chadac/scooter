# The MINIMAL sandbox BOOTSTRAP OCI image — a systemd-PID-1 barebones swap-only container.
#
# Evaluates modules/sandbox/bootstrap (the barebones config: systemd + overlay-store +
# firstboot; NO real system) with boot.isContainer, then packages it via the SHARED
# systemd-PID-1 recipe (pkgs/sandbox/mk-sandbox-image.nix) — the SAME packaging as the full
# image (pkgs/sandbox/root), just around a much smaller toplevel.
#
# This is the image every conversation actually boots. Its job is to reach the first
# `scooter-apply-module switch` to the real generation, which the warmed/cloned PVC brings.
# See modules/sandbox/bootstrap + todo/docs/MINIMAL_BOOTSTRAP_SANDBOX.md.

{ pkgs, lib, n2c
, name ? "agent-sandbox"
, tag ? "latest"
, extraModules ? [ ]
}:

let
  nixos = pkgs.nixos ({ ... }: {
    imports = [ ../../../modules/sandbox/bootstrap ] ++ extraModules;
    # Packaging-only: systemd PID 1 in a container, kernel/boot trimmed (the nixosTests
    # import modules/sandbox/bootstrap WITHOUT this, so they boot as a normal VM).
    boot.isContainer = true;
  });

  toplevel = nixos.config.system.build.toplevel;

  mkSandboxImage = import ../mk-sandbox-image.nix { inherit pkgs lib n2c; };
in
{
  inherit toplevel nixos;

  # nix build .#sandbox-image  ->  the barebones bootstrap image (systemd PID 1).
  image = mkSandboxImage { inherit toplevel name tag; };
}
