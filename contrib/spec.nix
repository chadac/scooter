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

      ONE tree per integration, holding both halves of it: `contrib/<name>/contrib.nix`
      declares what the contrib IS (`src`, `services`, `ui`, `skills`) and whatever
      deployment options it needs, and an operator configures those under
      `contribs.<name>`. `enable` is the single gate — it says whether this build
      contains the integration at all — and `shipGate` in modules/platform.nix fails
      the render for a contrib configured but not shipped.

      The per-contrib options are declared by each contrib using the strict module
      form, which is why `shorthandOnlyDefinesConfig` stays false below.
    '';
    type = lib.types.attrsOf (lib.types.submoduleWith {
      # shorthandOnlyDefinesConfig stays false so a contrib may use the strict
      # module form and declare its own options.
      modules = [ ./submodule.nix ];
    });
  };
}
