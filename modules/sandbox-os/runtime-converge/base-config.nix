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
  #
  # ONE exception, and it is why this file ALSO evaluates in pure mode (the nixosTest
  # evaluates it through the flake): the values we READ THROUGH — `import`, `pathExists`
  # — keep their context. A reconstructed absolute path proves nothing about which input
  # it came from, so pure eval refuses to access it; a context-carrying value IS a store
  # reference and works in both modes. Nothing EMBEDDED gains context, so the toplevel
  # hashes identically either way. Why: PR #610.
  nixpkgsArg = toString nixpkgs; # context PRESERVED — read through this, never embed it
  nixpkgsStr = builtins.unsafeDiscardStringContext nixpkgsArg;
  hasPathPrefix = builtins.substring 0 5 nixpkgsStr == "path:";
  prefixLen = if hasPathPrefix then 5 else 0;
  # The bare store-path STRING (no prefix). This is what programs.scooterModule.nixpkgs
  # must hold: applyModule interpolates it UNQUOTED as `nixpkgs = <bare path>;` into the
  # next re-converge's nix expr (a bare path literal), so a `path:`-prefixed value there
  # would break the second-generation build.
  nixpkgsBare = builtins.substring prefixLen (-1) nixpkgsStr;
  # What `import (… + "/nixos/…")` reads: the caller's own path/context when there is
  # one, reconstructed absolute path only for the pod's context-free `nixpkgs =
  # /nix/store/…;` literal (where eval is `--impure` anyway). `builtins.substring`
  # retains its input's context, so stripping `path:` does not strip that.
  nixpkgsPath =
    if builtins.isPath nixpkgs then nixpkgs
    else if builtins.hasContext nixpkgsArg then builtins.substring prefixLen (-1) nixpkgsArg
    else /. + nixpkgsBare;
  # The `path:` string form (idempotent — don't double-prefix).
  nixpkgsRef = if hasPathPrefix then nixpkgsStr else "path:" + nixpkgsStr;
  # The baked sandbox-os source-tree ROOT: modulesPath is `<tree>/modules/sandbox-os`
  # (reconverge-inputs.modulesSrc), so strip that trailing subdir to get the tree the
  # image baked. Context-free so `programs.scooterModule.modulesTree` (a str option) holds
  # a plain store path; `builtins.storePath` (in runtime-converge.nix) re-adds it as a
  # valid dependency. `lib` isn't a fn arg here, so strip the fixed suffix with builtins.
  modulesPathArg = toString modulesPath; # context PRESERVED — see nixpkgsPath above
  modulesPathStr = builtins.unsafeDiscardStringContext modulesPathArg;
  modulesSubdir = "/modules/sandbox-os";
  rootLen = builtins.stringLength modulesPathStr - builtins.stringLength modulesSubdir;
  modulesTreeRoot = builtins.substring 0 rootLen modulesPathStr;
  # The nix-stubs bits reconverge-inputs.nix vendored, handed to stub-set.nix so
  # the re-converge rebuilds the stub overlay. Without it `pkgs.uv` / `pkgs.marimo`
  # / `pkgs.awscli2` are the REAL packages here and a self-modify re-fattens the
  # system. Null when absent (a nixosTest evaluating this bare). See PR #502.
  # Read through the context-carrying value, same rule as nixpkgsPath: `pathExists` on
  # a context-free absolute path is refused in pure eval. Only the context-free
  # `modulesTreeRoot` is ever EMBEDDED.
  stubBitsRoot =
    if builtins.hasContext modulesPathArg then builtins.substring 0 rootLen modulesPathArg
    else modulesTreeRoot;
  stubBits =
    if !builtins.pathExists (stubBitsRoot + "/nix-stubs/lock.nix") then null
    else {
      lockLib = import (stubBitsRoot + "/nix-stubs/lock.nix") {
        lib = import (nixpkgsPath + "/lib");
      };
      flakeLock = stubBitsRoot + "/flake.lock";
      # The baked binary, not a fresh callPackage — that would compile Rust
      # inside the pod on every self-modify. storePath is banned in pure eval and
      # appendContext yields an identical context — see `storeRef` in
      # runtime-converge.nix, inlined here because this file is copied into the store
      # as a LONE file and so cannot import a sibling.
      nix-stubs =
        let p = builtins.readFile (stubBitsRoot + "/nix-stubs-bin"); in
        if builtins ? currentSystem then builtins.storePath p
        else builtins.appendContext p { ${p} = { path = true; }; };
    };

  evaled = import (nixpkgsPath + "/nixos/lib/eval-config.nix") {
    inherit system;
    modules = [
      modulesPath
      { boot.isContainer = true; }
      ({ lib, ... }: {
        # stub-set.nix turns these into the overlay (and lets a deployment
        # override which stub set that is).
        _module.args.stubBits = stubBits;
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
  };
in
{
  inherit (evaled) config;
  toplevel = evaled.config.system.build.toplevel;
}
