# Base-config builder, shipped INTO the sandbox image so the pod can re-build its
# OWN system toplevel at runtime — the GENERIC base config PLUS a deployment's
# mounted `.scooter/module.nix` — and `switch-to-configuration` to it.
#
# This mirrors pkgs/sandbox-os's `pkgs.nixos { imports = [ ../../modules/sandbox-os
# ] ++ extraModules; ... }` so the runtime-converged toplevel matches the booted
# one except for the injected module — keeping systemd + system.conf constant so
# the switch does NOT re-exec PID 1 (the switch-specialisation spike finding).
#
# Called in-pod by scooter-apply-module as:
#   nix build --impure --expr '(import <base-config> {
#     nixpkgs = <store path>; modulesPath = <store path>;
#     extraModules = [ /etc/agent-sandbox/scooter/module.nix ];
#   }).toplevel'
#
# `nixpkgs` + `modulesPath` are fixed store paths injected by the image, so the
# in-pod build needs no network and no flake ref.

{ nixpkgs            # store path to the pinned nixpkgs source
, modulesPath        # store path to modules/sandbox-os
, extraModules ? [ ] # the deployment's .scooter module(s) to inject
, system ? builtins.currentSystem
}:

let
  evaled = import (nixpkgs + "/nixos/lib/eval-config.nix") {
    inherit system;
    modules = [
      modulesPath
      { boot.isContainer = true; }
    ] ++ extraModules;
  };
in
{
  inherit (evaled) config;
  toplevel = evaled.config.system.build.toplevel;
}
