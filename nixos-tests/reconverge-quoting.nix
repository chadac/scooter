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
# EVERY ASSERTION HERE RUNS AT BUILD TIME, NEVER AT EVAL. `readFile`/`fromJSON` on
# the rendered list is import-from-derivation, which `nix flake show` (just ci)
# evaluates with disabled — so an eval-time read fails the whole flake, not just this
# check. Why: #718.

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

  # Both halves of the list the config asked for: the verbatim exprs, and the
  # repo-relative file rebased onto the baked tree.
  expected = mods ++ [ "${tree}/${treeRelative}" ];
  expectedFile = pkgs.writeText "expected-reconverge-modules.json" (builtins.toJSON expected);

  # The fixture's whole point is that the rendered list REFERS to the tree — that
  # reference is what attaches string context to the in-pod readFile, which is what
  # plain fromJSON refuses (#718). The REGISTERED references are the build-time
  # observable of it: readFile cannot see them from inside a sandbox, closureInfo can.
  listClosure = pkgs.closureInfo { rootPaths = [ listFile ]; };
in
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
  ${pkgs.jq}/bin/jq -e --slurpfile want ${expectedFile} '. == $want[0]' ${listFile} >/dev/null \
    || { echo "FAIL: rendered list is not the configured list." >&2
         echo "  want: $(cat ${expectedFile})" >&2
         echo "  got:  $(cat ${listFile})" >&2
         exit 1; }

  # 2. The rendered list REFERENCES the tree, so the in-pod read carries context and
  # the discard below is load-bearing. Without this the fixture can drift back to
  # paths nothing references — which is exactly how this check passed while the k3d
  # boot failed (#718): a nonexistent path renders a context-FREE string.
  grep -qxF '${tree}' ${listClosure}/store-paths \
    || { echo "FAIL: the rendered list does not reference ${tree}, so this check" >&2
         echo "      cannot see the #718 failure (fromJSON rejecting a store-path" >&2
         echo "      reference). Point the fixture at a real store path again." >&2
         exit 1; }

  # 3. The script reads THAT file — not some other copy, and not a list it rebuilt —
  # and it discards the string context, without which fromJSON refuses the read and
  # every switch dies at the build gate (#718).
  grep -qF 'builtins.fromJSON (builtins.unsafeDiscardStringContext (builtins.readFile ${listFile}))' "$script" \
    || { echo "FAIL: $script no longer reads ${listFile} inside its --expr," >&2
         echo "      or dropped the unsafeDiscardStringContext around the read (#718)." >&2
         echo "      If the mechanism moved, re-point this check; don't drop it." >&2
         exit 1; }

  # 4. The shell is NOT assembling the list again. A reintroduced fragment is the
  # #696 bug returning, and it would pass (1)-(3) while shipping broken.
  if grep -qE '^ *reconverge_(layers|carry)=' "$script"; then
    echo "FAIL: $script assembles the module list in the shell again — that is #696." >&2
    exit 1
  fi

  mkdir -p $out
  cp ${listFile} $out/reconverge-modules.json
''
