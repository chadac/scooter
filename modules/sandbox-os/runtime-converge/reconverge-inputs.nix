# The EXACT inputs the in-pod re-converge feeds base-config.nix — factored out so
# BOTH the runtime (runtime-converge.nix, which runs scooter-apply-module) and the
# nixosTest (which pre-builds the re-converged toplevel to seed the VM store) use
# the SAME derivations. If they drift, the test's pre-built `reconverged` is a
# different derivation than what the pod builds at runtime → cache miss → a
# from-source toplevel build that hangs/fails OFFLINE in the test VM.
#
# `baseConfig`  — the base-config.nix entrypoint the in-pod `nix build` imports.
# `modulesTree` — the repo, vendored at its own layout, so every relative reach a
#                 vendored module makes resolves in-pod exactly as it does at image
#                 build. It also vendors what the re-converge needs to REBUILD THE
#                 STUB OVERLAY in-pod (see below), which the repo does not contain.
# `modulesSrc`  — modulesPath passed to base-config.nix (<tree>/modules/sandbox-os).
#
# Why the stub bits are vendored: the sandbox's expensive tools (uv, marimo, ttyd,
# code-server, awscli2) are nix-stubs shims, applied as a nixpkgs overlay. A
# re-converge that could not reconstruct that overlay would evaluate those attrs as
# REAL packages and a self-modify would rebuild ~1 GB of tools it already has as
# shims. Reconstructing it needs two things the repo does not have: nix-stubs' own
# pure-Nix overlay (a flake INPUT), and the prebuilt nix-stubs BINARY — recorded as a
# store path so the in-pod eval references the baked one instead of compiling Rust in
# the pod. The lock mkOverlay checks against is the repo's own flake.lock.

{ pkgs, lib
  # { src; package; } — the nix-stubs flake input's source and its built binary.
  # Optional: a nixosTest that imports modules/sandbox-os bare has no stub overlay
  # to reconstruct, and base-config.nix skips it when the vendored bits are absent.
, nixStubs ? null
}:

let
  baseConfig = ./base-config.nix;

  # THE WHOLE REPO, at its own layout — not a curated subset. Every relative reach a
  # vendored module makes then resolves in-pod exactly as it does at image build
  # (`../../pkgs/broker-tools`, which itself reads `../../services/broker/…/cli.py`),
  # so nothing has to be enumerated here and nothing can be forgotten.
  #
  # node_modules is excluded EXPLICITLY, not just because it is gitignored: under the
  # flake the source is the git tree and it never appears, but a plain-path eval of
  # this repo would otherwise vendor ~1 GB of a dev machine's installed deps and hash
  # differently than CI. Why: PR #614.
  repoSrc = lib.cleanSourceWith {
    name = "scooter-src";
    src = lib.cleanSource ../../..;
    filter = path: type:
      !(type == "directory" && baseNameOf path == "node_modules");
  };

  modulesTree = pkgs.runCommand "sandbox-os-src" { } (''
    cp -r ${repoSrc} $out
    chmod -R u+w $out
  '' + lib.optionalString (nixStubs != null) ''
    # nix-stubs' Nix side is pure — no flake, no IFD — so it vendors as plain files.
    # (The lock mkOverlay checks against is the repo's own flake.lock, already here.)
    cp -r ${nixStubs.src}/nix $out/nix-stubs
    # The binary as a bare store path. It is already in the image closure (every
    # shim references it), so the in-pod eval resolves it offline.
    printf '%s' ${lib.escapeShellArg "${nixStubs.package}"} > $out/nix-stubs-bin
  '');
  modulesSrc = "${modulesTree}/modules/sandbox-os";
in
{ inherit baseConfig modulesTree modulesSrc; }
