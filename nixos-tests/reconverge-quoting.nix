# Pure build (no VM): the re-converge's module list reaches Nix INTACT.
#
# dev-env-reconverge-eval proves the re-converge expression EVALUATES. It cannot
# prove the list of layered modules ever reaches Nix: that list used to be
# interpolated into `nix build --expr "…"` as a DOUBLE-QUOTED bash string, so a
# Nix-level `"` emitted into it was consumed by the shell before Nix parsed
# anything. That is how the carry shipped broken — the script text read
# `[ "/nix/store/x.nix" ]`, bash handed Nix `[ /nix/store/x.nix ]`, and the
# `listOf str` option rejected a PATH. Nix-level eval sees nothing wrong, so only the
# nightly VM test caught it (#696, the same blind spot as #609).
#
# The list is a JSON file read inside the expr now (#717), so the shell never touches
# it and that class of bug is gone by construction. This check is what KEEPS it gone:
# the list must be in the file, the file must be what the script reads, the read must
# survive fromJSON, and the shell must not be assembling the list again.
#
# THE FIXTURE MUST USE A REAL STORE PATH. It used fake hashes, and that is why this
# check passed while the k3d boot failed: readFile's context comes from the file's
# REGISTERED references, so a nonexistent path renders a context-FREE string, and
# fromJSON only rejects a string with context. A real tree reproduces it. Why: #718.

{ pkgs, lib, sandboxModule }:

let
  # The production shape: a real vendored tree, with the layered module addressed
  # relative to it (extraReconvergeModuleFiles) — so the rendered entry is a store
  # path the list file genuinely references, as in an image.
  # nixpkgs' own source, as the stand-in vendored tree. Three properties the fixture
  # needs and a runCommand cannot give it: it is a BARE path string (the module
  # re-attaches context itself via storeRef, which in pure eval demands a context-free
  # input); it is ALREADY REALISED, so the opaque reference storeRef creates resolves
  # without a deriver to build; and it is a real store path, which is the whole point
  # (see the header). Nothing imports the entry, so any real relative file will do.
  tree = toString pkgs.path;
  treeRelative = "lib/default.nix";

  # Store-path-SHAPED but deliberately nonexistent: these cover the verbatim-expr
  # half of the list, which nothing here imports.
  mods = [
    "/nix/store/00000000000000000000000000000000-a-module.nix"
    "/nix/store/11111111111111111111111111111111-b-module.nix"
  ];

  node = (import (pkgs.path + "/nixos/lib/eval-config.nix") {
    inherit (pkgs.stdenv.hostPlatform) system;
    modules = [
      sandboxModule
      {
        programs.scooterModule = {
          enable = true;
          nixpkgs = "/nix/store/22222222222222222222222222222222-source";
          extraReconvergeModules = mods;
          modulesTree = tree;
          extraReconvergeModuleFiles = [ treeRelative ];
        };
        # Trims the kernel/initrd this check has no use for.
        boot.isContainer = true;
      }
    ];
  }).config;

  applyModule =
    lib.findFirst (p: (p.name or "") == "scooter-apply-module")
      (throw "scooter-apply-module is not in environment.systemPackages")
      node.environment.systemPackages;

  # The list as the image renders it. Reached through the CONFIG, so this check fails
  # if the image stops rendering it rather than passing on a file nobody reads.
  listFile = node.environment.etc."scooter/reconverge-modules.json".source;

  # The read the apply script performs, done HERE at eval time (the only place it can
  # be observed: inside a sandboxed build, nix cannot query the store DB, so readFile
  # finds no references and the context never appears).
  raw = builtins.readFile listFile;

  # The fixture reproduces production: the rendered list REFERS to the tree, so a plain
  # `fromJSON (readFile …)` would abort the switch. If this ever goes false the fixture
  # has drifted back to paths nothing references, and the guard below means nothing.
  ctxAsserted =
    if builtins.hasContext raw then true
    else throw ''
      reconverge-quoting: the rendered list carries NO string context, so this check
      cannot see the #718 failure (fromJSON rejecting a store-path reference). Point
      the fixture at a real store path again.
    '';

  # …and with the context discarded, as the script does, it parses to the configured
  # list. Both halves: the verbatim exprs and the tree-rebased file.
  parsed = assert ctxAsserted;
    builtins.fromJSON (builtins.unsafeDiscardStringContext raw);
  expected = mods ++ [ "${tree}/${treeRelative}" ];
  parsedOk =
    if parsed == expected then true
    else throw "reconverge-quoting: rendered list is ${builtins.toJSON parsed}, expected ${builtins.toJSON expected}";
in
assert parsedOk;
pkgs.runCommand "dev-env-reconverge-quoting" { } ''
  script=${applyModule}/bin/scooter-apply-module

  # 1. The rendered list IS the configured list — each entry a JSON string, which is
  # what `listOf str` needs when the script feeds it back as the carry.
  echo "rendered list:"
  cat ${listFile}
  ${pkgs.jq}/bin/jq -e 'type == "array"' ${listFile} >/dev/null \
    || { echo "FAIL: ${listFile} is not a JSON array" >&2; exit 1; }
  ${pkgs.jq}/bin/jq -e 'map(type == "string") | all' ${listFile} >/dev/null \
    || { echo "FAIL: an entry is not a JSON string — the carry would hand Nix a path" >&2; exit 1; }
  for m in ${lib.concatStringsSep " " mods}; do
    ${pkgs.jq}/bin/jq -e --arg m "$m" 'index($m) != null' ${listFile} >/dev/null \
      || { echo "FAIL: $m is missing from the rendered list" >&2; exit 1; }
  done

  # 2. The script reads THAT file — not some other copy, and not a list it rebuilt —
  # and it discards the string context, without which fromJSON refuses the read and
  # every switch dies at the build gate (#718).
  grep -qF 'builtins.fromJSON (builtins.unsafeDiscardStringContext (builtins.readFile ${listFile}))' "$script" \
    || { echo "FAIL: $script no longer reads ${listFile} inside its --expr," >&2
         echo "      or dropped the unsafeDiscardStringContext around the read (#718)." >&2
         echo "      If the mechanism moved, re-point this check; don't drop it." >&2
         exit 1; }

  # 3. The shell is NOT assembling the list again. A reintroduced fragment is the
  # #696 bug returning, and it would pass (1) and (2) while shipping broken.
  if grep -qE '^ *reconverge_(layers|carry)=' "$script"; then
    echo "FAIL: $script assembles the module list in the shell again — that is #696." >&2
    exit 1
  fi

  mkdir -p $out
  cp ${listFile} $out/reconverge-modules.json
''
