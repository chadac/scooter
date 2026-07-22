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
  # `nixpkgs` may arrive as a BARE store path (first converge, from the image) OR as a
  # `path:`-prefixed STRING (a later converge, re-injected via cfg.nixpkgs — the option
  # value the previous converge set on programs.scooterModule.nixpkgs). Normalize BOTH:
  #   nixpkgsPath — a real path for `import (… + "/nixos/…")` (strip any `path:` prefix)
  #   nixpkgsRef  — the `path:` string the lazy-tool stubs + flake registry embed. We MUST
  #                 reproduce the identical ref or the stubs hash differently and the
  #                 re-converge needlessly rebuilds system-path (~10min toolchain re-fetch).
  nixpkgsStr = toString nixpkgs;
  hasPathPrefix = builtins.substring 0 5 nixpkgsStr == "path:";
  # The bare filesystem path (strip a leading "path:"), as a real path for `import`.
  nixpkgsPath = /. + (if hasPathPrefix then builtins.substring 5 (-1) nixpkgsStr else nixpkgsStr);
  # The `path:` string form (idempotent — don't double-prefix).
  nixpkgsRef = if hasPathPrefix then nixpkgsStr else "path:" + nixpkgsStr;
  evaled = import (nixpkgsPath + "/nixos/lib/eval-config.nix") {
    inherit system;
    modules = [
      modulesPath
      { boot.isContainer = true; }
      ({ lib, ... }: {
        programs.lazyTools.defaultNixpkgs = lib.mkForce nixpkgsRef;
        devEnvNix.nixpkgs = lib.mkForce nixpkgsRef;
        # Keep the scooter-rebuild machinery ENABLED across a re-converge, and give it
        # the nixpkgs ref it needs. The image build enables it in pkgs/sandbox-os/
        # default.nix (outside modulesPath) AND sets programs.scooterModule.nixpkgs there
        # — so a re-converge importing only modulesPath would (a) default `enable` to
        # false, dropping scooter-rebuild/apply-module/env-status from PATH, and (b) leave
        # `.nixpkgs` undefined (the option has no default), failing the eval. Set BOTH
        # here — the reconverge entrypoint the pod actually builds — so the re-converged
        # system keeps a working scooter-rebuild. `.nixpkgs` is a STRING (the `path:` ref
        # form, matching what the image bakes so the lazy-tool stubs don't rehash).
        programs.scooterModule.enable = lib.mkForce true;
        programs.scooterModule.nixpkgs = lib.mkForce nixpkgsRef;
      })
    ] ++ extraModules;
    # NOTE: this in-pod eval does NOT set _module.args.nixStubsLib, so
    # carry-over.nix's `awscli` falls back to the FULL pkgs.awscli2 on a re-converge
    # (the booted image ships it as a nix-stubs lazy shim). Correctness-safe, but a
    # self-modify re-fattens ~145MB. FOLLOW-UP (todo-nix-stubs-reconverge-lockstep):
    # vendor nix-stubs into modulesTree + reconstruct nixStubsLib here so the lazy
    # shim survives re-converge — the "sandbox vends itself as a module" design.
  };
in
{
  inherit (evaled) config;
  toplevel = evaled.config.system.build.toplevel;
}
