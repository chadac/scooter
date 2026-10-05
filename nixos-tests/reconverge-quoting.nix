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
# the list must be in the file, the file must be what the script reads, and the shell
# must not be assembling the list again.

{ pkgs, lib, sandboxModule }:

let
  # Store-path-SHAPED but deliberately nonexistent: nothing is imported here, only
  # the rendered list and the script text are inspected.
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
  for m in ${lib.concatStringsSep " " mods}; do
    ${pkgs.jq}/bin/jq -e --arg m "$m" 'index($m) != null' ${listFile} >/dev/null \
      || { echo "FAIL: $m is missing from the rendered list" >&2; exit 1; }
  done

  # 2. The script reads THAT file — not some other copy, and not a list it rebuilt.
  grep -qF 'builtins.fromJSON (builtins.readFile ${listFile})' "$script" \
    || { echo "FAIL: $script no longer reads ${listFile} inside its --expr." >&2
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
