# mk-sandbox-image — the SHARED n2c packaging recipe for a systemd-PID-1 sandbox OCI image.
#
# Both sandbox images (pkgs/sandbox/root — the full real config; pkgs/sandbox/bootstrap — the
# barebones swap-only image) are the SAME packaging around a different NixOS `toplevel`:
#   - a baked Nix DB + full /nix/var/nix state layout (the local-overlay read-only lower
#     needs the complete state dir a real `nix-store --load-db` produces),
#   - /sbin/init + a writable /etc/machine-id + the boot dirs at the image root,
#   - a PID-1 init wrapper that remounts /sys/fs/cgroup rw (non-privileged crun boot),
#   - `container=docker`, the exec PATH, SIGRTMIN+3 stop signal, /workspace workdir.
#
# Factored here so the two images can't drift on the fiddly parts (the nixDb recipe, the
# cgroup remount). Callers build their own `nixos`/`toplevel` and hand it in.

{ pkgs, lib, n2c }:

{ toplevel
, name
, tag ? "latest"
}:

let
  # The Nix path-registration for the WHOLE system closure. n2c ships the store *paths* but
  # we need a REAL, registered, read-only Nix store baked in.
  closure = pkgs.closureInfo { rootPaths = [ toplevel ]; };

  # Files baked at the image root (outside the Nix store): the init symlink, writable
  # machine-id, and the dirs systemd expects at first boot.
  rootExtras = pkgs.runCommand "${name}-root" { } ''
    mkdir -p $out/sbin $out/etc
    ln -s ${toplevel}/init $out/sbin/init
    : > $out/etc/machine-id
    mkdir -p $out/var/log $out/run $out/tmp
    chmod 1777 $out/tmp
  '';

  # The baked Nix DB + the FULL /nix/var/nix state layout, at the image root. We do NOT use
  # n2c's `initializeNixDatabase` (it bakes only db.sqlite + a couple dirs); the local-overlay
  # store's read-only lower opens with root=/ and expects the COMPLETE state dir that a real
  # `nix-store --load-db` lays down (db/{schema,reserved,big-lock}, profiles/, temproots/, …).
  # See modules/sandbox/*/overlay-store.nix + NixOS/nix#11840.
  nixDb = pkgs.runCommand "${name}-nixdb" { } ''
    export NIX_STATE_DIR=$out/nix/var/nix
    mkdir -p $out/nix/var/nix $out/nix/store/.links
    ${pkgs.buildPackages.nix}/bin/nix-store --load-db < ${closure}/registration
  '';

  # PID-1 wrapper: make /sys/fs/cgroup writable (with CAP_SYS_ADMIN, under crun/non-priv),
  # THEN exec the NixOS stage-2 init. runc/crun mount cgroupfs read-only for a non-privileged
  # container, but systemd PID 1 must CREATE its cgroup subtree there — on a read-only cgroupfs
  # it exits 255 right after "starting systemd...". Best-effort remount; never fail boot on it.
  initWrapper = pkgs.writeScript "${name}-init-wrapper" ''
    #!${pkgs.busybox}/bin/sh
    ${pkgs.util-linux}/bin/mount -o remount,rw /sys/fs/cgroup 2>/dev/null || true
    exec ${toplevel}/init "$@"
  '';
in
n2c.buildImage {
  inherit name tag;

  # rootExtras ships /sbin/init, /etc/machine-id + the writable boot dirs; nixDb ships the
  # baked Nix DB + full state layout. rootExtras's /sbin/init -> ${toplevel} pulls the WHOLE
  # closure into the image without unpacking the system root at /.
  copyToRoot = [ rootExtras nixDb ];
  maxLayers = 100;

  config = {
    Entrypoint = [ "${initWrapper}" ];
    Env = [
      "container=docker"
      # PID 1's PATH — inherited by every kubelet `exec` (non-login `bash -c`). Prepend the
      # writable per-user nix profile bin (HOME=/workspace) + setuid wrappers.
      "PATH=/workspace/.nix-profile/bin:/run/wrappers/bin:/run/current-system/sw/bin:/usr/bin:/bin"
    ];
    StopSignal = "SIGRTMIN+3";  # systemd's clean-shutdown signal (not k8s's default SIGTERM)
    WorkingDir = "/workspace";
  };
}
