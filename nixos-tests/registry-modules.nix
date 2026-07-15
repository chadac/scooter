# Composition test for registry-modules.nix — the SHARED-registry module fetch.
#
# Pure EVAL (no VM): a file:// tarball fixture of <id>/module.nix + an ids-list file,
# evaluate registry-modules with the test-only overrides, and assert it imports the
# attached ids' module.nix. Fail-safe: no ids file -> imports nothing.
#
# The full in-pod fetch+switch is Tier-2 (real broker); this proves the read-ids +
# fetch + import LOGIC fast.

{ pkgs, lib, sandboxModule ? null }:

let
  # A fixture tarball laid out as the broker's /modules.tar.gz?ids= returns:
  # <id>/module.nix per attached module.
  fixture = pkgs.runCommand "registry-modules-fixture.tar.gz" { } ''
    mkdir -p m/alpha m/beta
    printf '%s' '{ ... }: { environment.etc."scooter-reg-alpha".text = "a"; }' > m/alpha/module.nix
    printf '%s' '{ ... }: { environment.etc."scooter-reg-beta".text = "b"; }' > m/beta/module.nix
    tar czf $out -C m .
  '';

  # The attached-ids file (a JSON list) — both alpha + beta attached.
  idsFile = pkgs.writeText "registry-ids.json" (builtins.toJSON [ "alpha" "beta" ]);
in
pkgs.runCommand "dev-env-registry-modules"
  {
    nativeBuildInputs = [ pkgs.nix ];
  } ''
  export HOME=$TMPDIR
  export NIX_STORE_DIR=$TMPDIR/store
  export NIX_STATE_DIR=$TMPDIR/state

  # (1) ids file + tarball override -> imports both attached modules.
  imported=$(SCOOTER_REGISTRY_IDS_FILE="${idsFile}" SCOOTER_REGISTRY_URL="file://${fixture}" \
    nix eval --impure --offline --extra-experimental-features 'nix-command flakes' --json --expr '
      let
        lib = (import ${pkgs.path} {}).lib;
        m = import ${../modules/sandbox-os/registry-modules.nix} { inherit lib; };
      in map (p: builtins.baseNameOf (builtins.dirOf p)) m.imports
    ')
  echo "imported ids: $imported"
  echo "$imported" | grep -q alpha || { echo "FAIL: alpha not imported"; exit 1; }
  echo "$imported" | grep -q beta  || { echo "FAIL: beta not imported"; exit 1; }

  # (2) Fail-safe: no ids file -> imports NOTHING.
  empty=$(SCOOTER_REGISTRY_IDS_FILE="$TMPDIR/none.json" SCOOTER_REGISTRY_URL="file://${fixture}" \
    nix eval --impure --offline --extra-experimental-features 'nix-command flakes' --json --expr '
      let
        lib = (import ${pkgs.path} {}).lib;
        m = import ${../modules/sandbox-os/registry-modules.nix} { inherit lib; };
      in m.imports
    ')
  echo "empty-case imports: $empty"
  [ "$empty" = "[]" ] || { echo "FAIL: expected no imports with no ids file, got $empty"; exit 1; }

  echo "OK: registry-modules imports the attached ids, nothing when unattached"
  touch $out
''
