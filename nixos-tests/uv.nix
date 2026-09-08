# Which uv the sandbox selects — modules/sandbox-os/uv.nix.
#
# Pure EVAL (no VM): the choice is a one-line conditional, but getting it wrong is
# invisible at runtime (`uv --version` looks identical either way) and only shows up
# as a wheel that installs and then fails to import. So assert it directly, in the
# tier that runs on EVERY PR.
#
# The other half of the story — that the choice SURVIVES a self-modify — lives in
# scooter-module.nix, which needs a full second toplevel and is excluded from per-PR
# runs (ci.yml HEAVY_TESTS). Keeping this half fast is what makes the regression
# catchable before a nightly.

{ pkgs, lib, sandboxModule ? null }:

let
  # Stands in for the uv-nix uv (a flake input the tests do not have). Only its
  # identity matters: it must be distinguishable from pkgs.uv.
  fakeUvNix = pkgs.writeShellScriptBin "uv" ''echo uv-nix-fake'';

  # uv.nix in isolation: the module system, plus a declaration of the one nixpkgs
  # option it writes to. Evaluating the whole sandbox config here would drag in a
  # NixOS eval for an assertion about four lines.
  evalUv = uvNix: (lib.evalModules {
    modules = [
      ../modules/sandbox-os/uv.nix
      {
        options.environment.systemPackages = lib.mkOption {
          type = lib.types.listOf lib.types.package;
          default = [ ];
        };
      }
      { _module.args = { inherit pkgs uvNix; }; }
    ];
  }).config;

  supplied = evalUv fakeUvNix;
  absent = evalUv null;

  # Compare store paths as INERT strings. Interpolating a package into the check
  # script would make it a build input, so an eval-check about which uv is chosen
  # would build a uv — pointless, and it drags the real (unstubbed) one into CI.
  path = p: builtins.unsafeDiscardStringContext (toString p);
  onPath = c: lib.concatMapStringsSep " " path c.environment.systemPackages;
in
pkgs.runCommand "dev-env-uv" { } ''
  # (1) Image supplied a uv-nix uv -> that is the uv, on PATH and as the option
  # other modules read.
  [ "${onPath supplied}" = "${path fakeUvNix}" ] || {
    echo "FAIL: uv on PATH is not the supplied uv-nix uv:"
    echo "  got ${onPath supplied}"
    exit 1
  }
  [ "${path supplied.sandboxOs.uv.package}" = "${path fakeUvNix}" ] || {
    echo "FAIL: sandboxOs.uv.package is not the supplied uv-nix uv — a module that"
    echo "      reads it (a service running uv) would get the wrong one."
    exit 1
  }

  # (2) No uv-nix (a bare nixosTest) -> fall back to nixpkgs' uv rather than
  # evaluating to nothing, which would leave the sandbox with no uv at all.
  [ "${onPath absent}" = "${path pkgs.uv}" ] || {
    echo "FAIL: without uv-nix the fallback is not pkgs.uv:"
    echo "  got ${onPath absent}"
    exit 1
  }

  echo "OK: uv-nix wins when supplied, pkgs.uv is the fallback"
  touch $out
''
