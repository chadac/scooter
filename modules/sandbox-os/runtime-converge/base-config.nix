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
  # CONTEXT-FREE from the start. `nixpkgs` may arrive WITH Nix store context (the
  # nixosTest's `toString nixpkgsSrc`, and the image builder's `system.extraDependencies`
  # copy — a realised derivation) OR as a bare path LITERAL with none (the pod's baked
  # `nixpkgs = /nix/store/…;` expr). base-config embeds this value in three places that
  # end up in the built toplevel: the lazy-tool shims + flake registry (`nixpkgsRef`),
  # and the re-injected `programs.scooterModule.nixpkgs` (which applyModule interpolates
  # verbatim into the NEXT converge's script). If the value carries context in one eval
  # but not the other, those derivations gain the `nixpkgs-src` drv as a spurious BUILD
  # INPUT in one case only — so the SAME base config hashes DIFFERENTLY, making the
  # test's pre-seeded `reconverged` a different toplevel than the pod builds at runtime
  # → cache miss → a from-source toolchain build that hangs OFFLINE in the pod/VM.
  # Discard the context up front so every derived value is byte-identical either way
  # (nixpkgs-src is guaranteed present out-of-band — system.extraDependencies / the baked
  # image closure — and the `import` below re-establishes the store dependency for eval).
  nixpkgsStr = builtins.unsafeDiscardStringContext (toString nixpkgs);
  hasPathPrefix = builtins.substring 0 5 nixpkgsStr == "path:";
  # The bare store-path STRING (no prefix). This is what programs.scooterModule.nixpkgs
  # must hold: applyModule interpolates it UNQUOTED as `nixpkgs = <bare path>;` into the
  # next re-converge's nix expr (a bare path literal), so a `path:`-prefixed value there
  # would break the second-generation build.
  nixpkgsBare = builtins.substring (if hasPathPrefix then 5 else 0) (-1) nixpkgsStr;
  # The bare filesystem path, as a real path for `import (… + "/nixos/…")`.
  nixpkgsPath = /. + nixpkgsBare;
  # The `path:` string form (idempotent — don't double-prefix).
  nixpkgsRef = if hasPathPrefix then nixpkgsStr else "path:" + nixpkgsStr;
  # The baked sandbox-os source-tree ROOT: modulesPath is `<tree>/modules/sandbox-os`
  # (reconverge-inputs.modulesSrc), so strip that trailing subdir to get the tree the
  # image baked. Context-free so `programs.scooterModule.modulesTree` (a str option) holds
  # a plain store path; `builtins.storePath` (in runtime-converge.nix) re-adds it as a
  # valid dependency. `lib` isn't a fn arg here, so strip the fixed suffix with builtins.
  modulesPathStr = builtins.unsafeDiscardStringContext (toString modulesPath);
  modulesSubdir = "/modules/sandbox-os";
  modulesTreeRoot =
    builtins.substring 0 (builtins.stringLength modulesPathStr - builtins.stringLength modulesSubdir) modulesPathStr;
  evaled = import (nixpkgsPath + "/nixos/lib/eval-config.nix") {
    inherit system;
    modules = [
      modulesPath
      { boot.isContainer = true; }
      ({ lib, ... }: {
        programs.lazyTools.defaultNixpkgs = lib.mkForce nixpkgsRef;
        devEnvNix.nixpkgs = lib.mkForce nixpkgsRef;
        # Keep programs.scooterModule ENABLED across the re-converge so scooter-rebuild
        # / scooter-apply-module / scooter-env-status stay on PATH after a self-modify
        # switch (previously they were dropped — the sandbox lost its own rebuild tool).
        #
        # This is safe to build OFFLINE because there is only ONE pkgs / one modulesTree:
        # `runtime-converge.nix` derives `modulesTree` (system.extraDependencies) from
        # `reconverge-inputs.nix` using the pkgs THIS eval-config instantiates from the
        # pinned `nixpkgs` — the SAME pinned source the image was built from. So the
        # `sandbox-os-src` derivation the re-converge references is byte-identical to the
        # one baked into the image closure (a cache hit / already-valid path), not a
        # fresh from-source build. The image builder + the nixosTest pre-build this
        # exact toplevel via the same base-config.nix, so its closure (incl. modulesTree)
        # is present offline.
        #
        # Re-inject the nixpkgs store path the option needs (it has no default) so the
        # re-evaluated module type-checks; the applyModule in-pod expr no longer sets it.
        # Use the BARE path (not nixpkgsRef) — applyModule interpolates it unquoted as a
        # bare path literal into the next converge's nix expr.
        programs.scooterModule.enable = lib.mkForce true;
        programs.scooterModule.nixpkgs = lib.mkForce nixpkgsBare;
        # Reference the ALREADY-BAKED sandbox-os source tree (present in the pod's
        # offline store) instead of letting runtime-converge.nix re-derive it — a
        # self-modify re-eval of reconverge-inputs.nix produces a DIFFERENT
        # sandbox-os-src hash (its `lib.cleanSource ../.` runs against this baked store
        # subtree, not the repo), which isn't in the store → the toplevel build fails
        # "path '…-sandbox-os-src' is not valid". modulesPath is `<bakedTree>/modules/
        # sandbox-os`, so the tree root is that with the trailing subdir stripped.
        programs.scooterModule.modulesTree = lib.mkForce modulesTreeRoot;
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
