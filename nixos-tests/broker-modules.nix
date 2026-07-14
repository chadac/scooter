# Composition test for broker-modules.nix — the deployment-DEFAULT module import.
#
# Pure EVAL (no VM): build a file:// tarball fixture of two `<name>.nix` files at the
# root, evaluate broker-modules with SCOOTER_DEFAULT_MODULES_URL pointing at it, and
# assert it imports BOTH. Also assert the fail-safe: with NO url configured it imports
# nothing.
#
# The full in-pod build+switch is exercised in the Tier-2 cluster tier (real broker,
# real network); this proves the fetch + import LOGIC fast and deterministically.

{ pkgs, lib, sandboxModule ? null }:

let
  # A fixture tarball: <name>.nix for two default modules at the tarball root, each a
  # cheap marker (so the assert can name them by baseNameOf).
  fixture = pkgs.runCommand "broker-modules-fixture.tar.gz" { } ''
    mkdir m
    printf '%s' '{ ... }: { environment.etc."scooter-default-alpha".text = "a"; }' > m/alpha.nix
    printf '%s' '{ ... }: { environment.etc."scooter-default-beta".text = "b"; }' > m/beta.nix
    tar czf $out -C m .
  '';
in
pkgs.runCommand "dev-env-broker-modules"
  {
    nativeBuildInputs = [ pkgs.nix ];
  } ''
  export HOME=$TMPDIR
  export NIX_STORE_DIR=$TMPDIR/store
  export NIX_STATE_DIR=$TMPDIR/state

  # (1) With the URL override -> imports both default modules. Inputs are a fixed store
  # path + a file:// tarball, so the eval is deterministic and needs no network.
  imported=$(SCOOTER_DEFAULT_MODULES_URL="file://${fixture}" \
    nix eval --impure --offline --extra-experimental-features 'nix-command flakes' --json --expr '
      let
        lib = (import ${pkgs.path} {}).lib;
        m = import ${../modules/sandbox-os/broker-modules.nix} { inherit lib; };
      in map (p: builtins.baseNameOf p) m.imports
    ')
  echo "imported: $imported"
  echo "$imported" | grep -q alpha.nix || { echo "FAIL: alpha.nix not imported"; exit 1; }
  echo "$imported" | grep -q beta.nix  || { echo "FAIL: beta.nix not imported"; exit 1; }

  # (2) Fail-safe: no BROKER_URL and no override -> imports NOTHING (empty list).
  empty=$(env -u BROKER_URL -u SCOOTER_DEFAULT_MODULES_URL \
    nix eval --impure --offline --extra-experimental-features 'nix-command flakes' --json --expr '
      let
        lib = (import ${pkgs.path} {}).lib;
        m = import ${../modules/sandbox-os/broker-modules.nix} { inherit lib; };
      in m.imports
    ')
  echo "empty-case imports: $empty"
  [ "$empty" = "[]" ] || { echo "FAIL: expected no imports with no broker url, got $empty"; exit 1; }

  echo "OK: broker-modules imports the default modules, and imports nothing when unconfigured"
  touch $out
''
