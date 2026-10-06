# The contrib schema. Why: PR #585.
#
# `lib`-ONLY, deliberately: this is imported by every eval that reads the registry —
# the package build (contrib/default.nix), the sandbox image
# (contrib/sandbox-modules.nix) and the kubenix platform (modules/platform.nix).
# Only the first of those has a `pkgs`. The build half — the one thing that needs
# one — is plain Nix over the evaluated spec in contrib/build.nix, not an option in
# here. Why: #711.
{ lib, ... }:

{
  options.contribs = lib.mkOption {
    default = { };
    description = ''
      Contribs by name — integration packages that plug into a service via entry
      points.

      A property of the SOURCE TREE, not a deployment knob: every definition comes
      from a `contrib/<name>/contrib.nix`, and what an operator configures is the
      `scooter.*` options a contrib declares in its own `platform.nix`. The platform
      eval carries this tree only so it can read what the shipped contribs
      contribute (their skills) without a second module system to disagree with.
    '';
    type = lib.types.attrsOf (lib.types.submoduleWith {
      # shorthandOnlyDefinesConfig stays false so a contrib may use the strict
      # module form and declare its own options.
      modules = [ ./submodule.nix ];
    });
  };
}
