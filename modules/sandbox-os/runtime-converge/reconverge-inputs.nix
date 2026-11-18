# The inputs the in-pod re-converge feeds base-config.nix, shared by the runtime
# (runtime-converge.nix) and the nixosTest so both build the same derivations.
# `baseConfig` is the entrypoint the in-pod `nix build` imports, `modulesTree` is
# the repo vendored at its own layout plus the nix-stubs source
# needed to rebuild the stub overlay in-pod, and `modulesSrc` is the modulesPath
# passed to base-config.nix.

{ pkgs, lib
  # `{ src; stubArgs; }` of the nix-stubs flake input; null when there is no stub overlay to reconstruct.
, nixStubs ? null
  # name -> store path of each skill directory (scooter.skillDirs), copied into the
  # tree with a module that re-declares them, so the in-pod eval never fetches.
, skillDirs ? { }
  # name -> out-of-tree contrib src, copied to contrib-ext/<name>.
, contribSrcs ? { }
  # The image's stub sets (contrib/sandbox-modules.nix), listed in stub-sets.json.
, stubSets ? { }
  # The contribs' extra stubs.nix arguments, vendored with the base set's.
, stubArgs ? { }
}:

let
  baseConfig = ./base-config.nix;

  # An explicit allowlist of the paths the in-pod re-converge resolves at runtime: everything vendored here lands in every image's content hash, and a missing path fails the re-converge loudly rather than polluting hashes.
  repoRoot = ../../..;
  repoSrc = lib.fileset.toSource {
    root = repoRoot;
    fileset = lib.fileset.unions [
      (repoRoot + "/modules")
      # The re-converge module list names contrib/<name>/sandbox.nix paths under this tree.
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
    # Whole source, so the pod re-derives the image's binary.
    cp -r ${nixStubs.src} $out/nix-stubs
    # stubs.nix's extra arguments (uv-nix's source), one directory each, read back by base-config.nix.
    mkdir -p $out/stub-args
    ${lib.concatStrings (lib.mapAttrsToList (name: src: ''
      cp -r ${src} $out/stub-args/${name}
    '') (lib.attrsets.unionOfDisjoint (nixStubs.stubArgs or { }) stubArgs))}
    # Each set's flake.lock that isn't scooter's, read back through stub-sets.json.
    mkdir -p $out/stub-flake-locks
    ${lib.concatStrings (lib.mapAttrsToList (name: s: ''
      cp ${s.flakeLock} $out/stub-flake-locks/${name}.lock
    '') (lib.filterAttrs (_: s: !ownFlakeLock s) stubSets))}
    cp ${stubSetsFile} $out/stub-sets.json
  '' + lib.optionalString (skillDirs != { }) ''
    mkdir -p $out/skill-dirs
    ${lib.concatStrings (lib.mapAttrsToList (name: src: ''
      cp -r ${src} $out/skill-dirs/${name}
    '') skillDirs)}
    chmod -R u+w $out/skill-dirs
    cp ${skillModule} $out/skill-dirs/module.nix
  '' + lib.optionalString (contribSrcs != { }) ''
    mkdir -p $out/contrib-ext
    ${lib.concatStrings (lib.mapAttrsToList (name: src: ''
      cp -r ${src} $out/contrib-ext/${name}
    '') contribSrcs)}
  '');

  ownFlakeLock = s: toString s.flakeLock == toString (repoRoot + "/flake.lock");

  # Each stub set's directory and flake.lock, relative to the tree.
  stubSetsFile = pkgs.writeText "stub-sets.json" (builtins.toJSON (lib.mapAttrs
    (name: s: {
      dir = s.tree;
      flakeLock = if ownFlakeLock s then "flake.lock" else "stub-flake-locks/${name}.lock";
    })
    stubSets));

  # Same content and same name as at image build, so the store paths match and a
  # self-modify does not churn /etc.
  skillModule = pkgs.writeText "skill-dirs-module.nix" ''
    {
      scooter.skillDirs = {
    ${lib.concatStrings (lib.mapAttrsToList (name: _: ''
        ${builtins.toJSON name} = builtins.path { path = ./${name}; name = ${builtins.toJSON "skill-${name}"}; };
    '') skillDirs)}  };
    }
  '';
  modulesSrc = "${modulesTree}/modules/sandbox-os";
in
{ inherit baseConfig modulesTree modulesSrc; }
