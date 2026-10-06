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
  # AN EXPLICIT FILESET, not a filter over the whole tree.
  #
  # WHY IT MATTERS: content tags come from the image's store hash, so anything
  # vendored here lands in EVERY image's tag. With the whole repo vendored,
  # editing a workflow comment changed the sandbox-os tag -- verified, a one-line
  # comment in ci.yml moved it from zd4vniczzw4g to djhfmr3sipms. That
  # invalidates the k3d registry cache, re-pushes all eight images, and rebuilds
  # `nix build .#k3d-image-refs` on a run where nothing about the product moved.
  #
  # WHY A FILESET AND NOT A FILTER: `lib.cleanSource ../../..` COPIES the tree to
  # the store first; a cleanSourceWith filter then runs over that already-copied
  # path, so the inner copy's hash -- .github included -- is what propagates.
  # Denylisting also loses by construction: every new top-level directory is
  # vendored by default and silently re-couples CI churn to image identity.
  # An allowlist fails the other way, which is the safe way: a missing path
  # breaks the in-pod re-converge loudly instead of quietly polluting hashes.
  #
  # WHAT IS HERE is what the re-converge actually resolves at runtime -- the
  # vendored module makes relative references (`../../pkgs/broker-tools`, which
  # itself reads `../../services/broker/…/cli.py`), plus the flake lock the stub
  # overlay checks against. If an in-pod eval starts failing on a missing path,
  # add it HERE rather than widening back to the whole tree.
  repoRoot = ../../..;
  repoSrc = lib.fileset.toSource {
    root = repoRoot;
    fileset = lib.fileset.unions [
      (repoRoot + "/modules")
      # contrib/: the re-converge module list (programs.scooterModule.
      # extraReconvergeModuleFiles, rendered by runtime-converge.nix) holds paths
      # UNDER THIS TREE -- contrib/<name>/sandbox.nix -- so each enabled contrib's
      # sandbox half is read from here at re-converge time. The registry itself is
      # NOT evaluated in the pod any more (#717); the files still have to be here,
      # and an omission fails the switch loudly, which is what this allowlist is for.
      (repoRoot + "/contrib")
      (repoRoot + "/pkgs")
      (repoRoot + "/services")
      (repoRoot + "/lib")
      (repoRoot + "/nix")
      (repoRoot + "/flake.nix")
      (repoRoot + "/flake.lock")
    ];
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
