# The EXACT inputs the in-pod re-converge feeds base-config.nix — factored out so
# BOTH the runtime (runtime-converge.nix, which runs scooter-apply-module) and the
# nixosTest (which pre-builds the re-converged toplevel to seed the VM store) use
# the SAME derivations. If they drift, the test's pre-built `reconverged` is a
# different derivation than what the pod builds at runtime → cache miss → a
# from-source toplevel build that hangs/fails OFFLINE in the test VM.
#
# `baseConfig`  — the base-config.nix entrypoint the in-pod `nix build` imports.
# `modulesTree` — a vendored source tree placing modules/sandbox-os AND
#                 pkgs/broker-tools + the broker cli.py at the same relative layout,
#                 so the base config's `../../pkgs/broker-tools` overlay resolves.
#                 It also vendors what the re-converge needs to REBUILD THE STUB
#                 OVERLAY in-pod (see below).
# `modulesSrc`  — modulesPath passed to base-config.nix (<tree>/modules/sandbox-os).
#
# Why the stub bits are vendored: the sandbox's expensive tools (uv, marimo, ttyd,
# code-server, awscli2) are nix-stubs shims, applied as a nixpkgs overlay. A
# re-converge that could not reconstruct that overlay would evaluate those attrs as
# REAL packages and a self-modify would rebuild ~1 GB of tools it already has as
# shims. Reconstructing it needs three things that are not otherwise in the tree:
# nix-stubs' pure-Nix overlay, this repo's flake.lock (the lock is synced to it),
# and the prebuilt nix-stubs BINARY — recorded as a store path so the in-pod eval
# references the baked one instead of compiling Rust in the pod.

{ pkgs, lib
  # { src; package; } — the nix-stubs flake input's source and its built binary.
  # Optional: a nixosTest that imports modules/sandbox-os bare has no stub overlay
  # to reconstruct, and base-config.nix skips it when the vendored bits are absent.
, nixStubs ? null
}:

let
  baseConfig = ./base-config.nix;

  modulesTree = pkgs.runCommand "sandbox-os-src" { } (''
    mkdir -p $out/modules $out/pkgs $out/services/broker/broker/aws
    cp -r ${lib.cleanSource ../.} $out/modules/sandbox-os
    cp -r ${../../../pkgs/broker-tools} $out/pkgs/broker-tools
    cp ${../../../services/broker/broker/aws/cli.py} $out/services/broker/broker/aws/cli.py
  '' + lib.optionalString (nixStubs != null) ''
    # nix-stubs' Nix side is pure — no flake, no IFD — so it vendors as plain files.
    cp -r ${nixStubs.src}/nix $out/nix-stubs
    # stubs.lock is synced to this flake.lock, and mkOverlay asserts the two agree.
    cp ${../../../flake.lock} $out/flake.lock
    # The binary as a bare store path. It is already in the image closure (every
    # shim references it), so the in-pod eval resolves it offline.
    printf '%s' ${lib.escapeShellArg "${nixStubs.package}"} > $out/nix-stubs-bin
  '');
  modulesSrc = "${modulesTree}/modules/sandbox-os";
in
{ inherit baseConfig modulesTree modulesSrc; }
