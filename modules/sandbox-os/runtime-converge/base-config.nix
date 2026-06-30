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
  # `nixpkgs` is a BARE store path (so we can `import` it). The lazy-tool stubs +
  # the flake registry, however, embed a flake-REF string verbatim — and the image
  # bakes those with a `path:`-prefixed ref. We MUST produce the identical ref here
  # or the stubs hash differently and the re-converge needlessly rebuilds
  # system-path (and re-substitutes the toolchain in-pod, ~10min). So derive the
  # `path:` form from the bare path and force it on lazyTools/devEnvNix below.
  nixpkgsRef = "path:" + (toString nixpkgs);
  evaled = import (nixpkgs + "/nixos/lib/eval-config.nix") {
    inherit system;
    modules = [
      modulesPath
      { boot.isContainer = true; }
      ({ lib, ... }: {
        programs.lazyTools.defaultNixpkgs = lib.mkForce nixpkgsRef;
        devEnvNix.nixpkgs = lib.mkForce nixpkgsRef;
      })
    ] ++ extraModules;
  };
in
{
  inherit (evaled) config;
  toplevel = evaled.config.system.build.toplevel;
}
