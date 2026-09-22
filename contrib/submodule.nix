# The option preset every contrib gets, and the build that turns it into packages.
#
# A MODULE, not a `mkContribSubmodule` function: a contrib's own `options` merge
# straight into this one, so extending the preset costs nothing and needs no
# `extraOptions` escape hatch. A contrib that wants its own settings writes the
# strict module form and they become part of its config tree:
#
#   contribs.jira = { config, ... }: {
#     options.siteUrl = lib.mkOption { type = lib.types.str; };
#     config.services.broker.enable = true;
#   };
#
# `scooter` is the PARENT config (every contrib, already evaluated), which is what
# lets one contrib's dependency list name another's package. Why: PR #585.
{ name, lib, config, scooter, python3Packages, scooterBrokerLib, scooterWebhooksLib, broker, webhooks, ... }:

let
  inherit (lib) mkOption mkEnableOption types literalExpression;

  # The two extension surfaces. A contrib is built ONCE PER SERVICE against only
  # the surface of that service: one build carrying both would drag
  # scooter_webhooks_lib (and sqlalchemy/asyncpg/aiosqlite) into the broker image.
  # Why: PR #567.
  surfaces = {
    broker = { surface = scooterBrokerLib; entryModule = "broker_provider"; };
    webhooks = { surface = scooterWebhooksLib; entryModule = "webhooks_handler"; };
  };

  # Contribs are prefixed `scooterContrib<Name>`: a bare `ps.jira` would shadow
  # nixpkgs' own python3Packages.jira (the Jira API client), and a dependency
  # silently resolving to the wrong package is worse than a longer name.
  contribAttrName = n:
    "scooterContrib" + lib.toUpper (lib.substring 0 1 n) + lib.substring 1 (-1) n;

  # What a `pythonDeps` function receives: nixpkgs' python3Packages plus every
  # contrib built for THIS service, so one field expresses both "a library from
  # nixpkgs" and "another contrib" and a dep cannot pull the wrong surface in.
  # Restricted to contribs that actually target the service, so depending on one
  # that does not is a missing-attribute error rather than a bad build.
  pkgsFor = svc: python3Packages // lib.mapAttrs'
    (n: c: lib.nameValuePair (contribAttrName n) c.services.${svc}.package)
    (lib.filterAttrs (_: c: c.enable && c.services.${svc}.enable) scooter.contribs);

  # tests/ is shared across variants, so a webhooks-only test still has to import
  # in the broker variant -- the same reason the real services are check inputs.
  # Resolved against THIS variant's package set, and check-only, so it never
  # widens the runtime closure.
  checkDepsFor = svc: lib.concatMap (s: s.pythonDeps (pkgsFor svc))
    (lib.attrValues (lib.filterAttrs (_: s: s.enable) config.services));

  buildFor = svc:
    let s = surfaces.${svc}; in
    python3Packages.buildPythonPackage {
      # Must stay the DISTRIBUTION name: the metadata-check hook looks the wheel
      # up by it. Variants differ by inputs, not pname.
      pname = config.distName;
      inherit (config) version src;
      pyproject = true;

      # Contribs standardize on hatchling (declared in each contrib's
      # [build-system]); nixpkgs needs the backend as an explicit build input.
      build-system = [ python3Packages.hatchling ];

      dependencies = [ python3Packages.fastapi s.surface ]
        ++ config.services.${svc}.pythonDeps (pkgsFor svc);

      # Checked in the environment it will actually live in, so a bad import fails
      # this build instead of vanishing at service startup.
      pythonImportsCheck = [ config.pyModule "${config.pyModule}.${s.entryModule}" ];

      nativeCheckInputs = (with python3Packages; [
        pytestCheckHook
        pytest-asyncio
        broker
        webhooks
      ]) ++ checkDepsFor svc;

      meta.description = "Scooter contrib module: ${name} (${svc})";
    };

  serviceModule = svc: { ... }: {
    options = {
      enable = mkEnableOption "the ${svc} half of this contrib";

      pythonDeps = mkOption {
        type = types.functionTo (types.listOf types.package);
        default = _: [ ];
        example = literalExpression "ps: [ ps.httpx ps.scooterContribJira ]";
        description = ''
          Extra Python dependencies for the ${svc} variant, beyond fastapi and the
          ${svc} extension surface. Declared per service because a dep listed for
          both halves lands in both closures — the surface leak the per-service
          split exists to stop.
        '';
      };

      package = mkOption {
        type = types.package;
        readOnly = true;
        description = "This contrib built for ${svc}. Set by the framework.";
      };
    };

    config.package = buildFor svc;
  };
in
{
  options = {
    enable = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Inject this contrib into the images of the services it targets.

        `false` does NOT mean "unbuilt": every contrib in the tree is still built
        and its tests still run (`nix build .#contrib-echo`, `.#contribs-all`), so
        reference material cannot rot undetected. Being in no image is what
        disabled means here; "do not build it" is `rm -r` on the directory.
      '';
    };

    src = mkOption {
      type = types.path;
      description = "The contrib's source directory (its pyproject.toml lives here).";
    };

    version = mkOption {
      type = types.str;
      default = "0.0.0";
      description = "Version stamped on the built distribution.";
    };

    distName = mkOption {
      type = types.str;
      default = "scooter-contrib-${name}";
      readOnly = true;
      description = "Distribution name. Fixed by convention; the metadata check depends on it.";
    };

    pyModule = mkOption {
      type = types.str;
      default = "scooter_contrib_${name}";
      readOnly = true;
      description = "Import name. Fixed by convention; entry points resolve through it.";
    };

    services = mkOption {
      default = { };
      description = ''
        Which service image(s) this contrib plugs into, and what each half needs.
        The set of services is fixed, so a typo is an eval error naming the option
        rather than a variant that silently never gets built.
      '';
      type = types.submodule {
        options = lib.mapAttrs
          (svc: _: mkOption {
            type = types.submodule (serviceModule svc);
            default = { };
            description = "The ${svc} half of this contrib.";
          })
          surfaces;
      };
    };
  };
}
