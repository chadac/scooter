# Pure build (no VM): the re-converge expression survives the SHELL.
#
# dev-env-reconverge-eval proves the re-converge expression EVALUATES. It cannot
# prove the expression ever reaches Nix intact: scooter-apply-module assembles
# `nix build --expr "…"` as a DOUBLE-QUOTED bash string, so a Nix-level `"` emitted
# into it is consumed by the shell before Nix parses anything. That is how the
# `extraReconvergeModules` carry module shipped broken — the script text read
# `[ "/nix/store/x.nix" ]`, bash handed Nix `[ /nix/store/x.nix ]`, and the
# `listOf str` option rejected a PATH. Nix-level eval sees nothing wrong, so only
# the nightly VM test caught it (#696, the same blind spot as #609).
#
# So: build the REAL script from a config with a non-empty list, expand its
# fragments with a REAL shell, and assert Nix would receive strings. No VM, no
# toplevel build.

{ pkgs, lib, sandboxModule }:

let
  # Store-path-SHAPED but deliberately nonexistent: nothing is imported here, the
  # fragments are only expanded and inspected as text.
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
in
pkgs.runCommand "dev-env-reconverge-quoting" { } ''
  script=${applyModule}/bin/scooter-apply-module

  # Expand the generated assignment in a real shell and print what the --expr string
  # would carry. One line by construction (the fragment is a single-line Nix
  # expression), so grabbing it alone keeps the rest of the script out of the eval.
  # The coupling to the `reconverge_carry` name is deliberate: it is the only part of
  # the script expandable in isolation. If it is renamed, re-point this grep.
  assignment=$(grep -m1 '^ *reconverge_carry=' "$script" || true)
  if [ -z "$assignment" ]; then
    echo "FAIL: $script no longer assigns reconverge_carry, so this check cannot" >&2
    echo "      see what --expr carries. Re-point the grep; don't drop the check." >&2
    exit 1
  fi

  carry=$(${pkgs.bash}/bin/bash -c '
    set -eu
    eval "$1"
    printf "%s" "''${reconverge_carry}"
  ' _ "$assignment")
  echo "carry fragment after shell expansion:"
  echo "  $carry"

  # The whole point: each entry must still be a quoted Nix STRING. A bare
  # /nix/store/… here is a path, and the option is `listOf str` — the switch dies
  # with "is not of type `string'" the moment extraReconvergeModules is non-empty.
  for m in ${lib.concatStringsSep " " mods}; do
    case "$carry" in
      *"\"$m\""*) echo "ok: $m is a Nix string" ;;
      *"$m"*)
        echo "FAIL: $m reached Nix as a PATH — the shell ate its quotes" >&2
        exit 1 ;;
      *)
        echo "FAIL: $m is missing from the carry fragment entirely" >&2
        exit 1 ;;
    esac
  done

  mkdir -p $out
  printf '%s\n' "$carry" > $out/carry.nix
''
