# Linux only; kubectl is in the base set.
{ pkgs }:
pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
  docker = { package = pkgs.docker; bins = [ "docker" "dockerd" ]; };
  crun = pkgs.crun;
  k3d = pkgs.k3d;
}
