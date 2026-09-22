# The re-converged toplevel `scooter-apply-module` builds IN THE POD — as one
# expression, shared by the two checks that need it:
#
#   - scooter-module.nix (the VM test) pre-seeds its closure into the VM store, so
#     the in-pod build is an offline CACHE HIT instead of a from-source rebuild;
#   - reconverge-eval.nix forces it to EVALUATE on every PR, without the VM.
#
# They must stay the same expression: the VM test's hermeticity rests on the
# toplevel it seeds being byte-identical to the one the pod builds, and the cheap
# check is only a guard for the expensive one if it evaluates the same thing.

{ pkgs, lib }:

let
  scooterFixture = ./fixtures/scooter;

  # The EXACT inputs the in-pod build feeds base-config.nix, from the SAME helper
  # runtime-converge.nix uses (single source of truth). `modulesSrc` is a VENDORED
  # tree (modules/sandbox-os + pkgs/broker-tools at a fixed layout), NOT the bare
  # module dir: building `reconverged` with `sandboxModule` directly produces a
  # DIFFERENT derivation than the runtime builds -> cache miss -> from-source build
  # that hangs OFFLINE in the VM.
  reconvergeInputs = import ../modules/sandbox-os/runtime-converge/reconverge-inputs.nix { inherit pkgs lib; };
in
rec {
  # The nixpkgs source the in-pod build imports. Copy it into the store as a
  # concrete derivation output so it's a realised path the VM definitely has
  # (a bare `pkgs.path` source ref isn't reliably present in the VM store).
  nixpkgsSrc = pkgs.runCommand "nixpkgs-src" { } ''
    cp -r ${pkgs.path} $out
  '';

  # MUST mirror what scooter-apply-module builds exactly — same modulesSrc, same
  # nixpkgs, same module order — including the keep-vm-units module threaded via
  # extraReconvergeModules.
  #
  # Pass `nixpkgs`/`modulesPath` WITH their store context. base-config.nix reads
  # through these (it `import`s them) and discards the context only for the strings
  # it embeds — a context-free absolute path here is what pure eval refuses, which
  # is how this check broke for ten days (#609). The toplevel hashes identically
  # either way, so the pod's bare-path call still builds this same derivation.
  toplevel = (import reconvergeInputs.baseConfig {
    nixpkgs = toString nixpkgsSrc;
    modulesPath = reconvergeInputs.modulesSrc;
    system = pkgs.system;
    extraModules = [
      # base-config.nix force-sets programs.scooterModule.{enable,nixpkgs} itself
      # (so scooter-rebuild stays on PATH across the re-converge), so we do NOT set
      # nixpkgs here — a second mkForce would conflict.
      ./fixtures/keep-vm-units.nix
      "${scooterFixture}/module.nix"
    ];
  }).toplevel;
}
