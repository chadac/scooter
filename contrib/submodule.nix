# The option preset every contrib gets, plus its build.
#
# A module, not a mkContribSubmodule function, so a contrib's own `options` merge
# in without an extraOptions hatch. `scooter` is the parent config. Why: PR #585.
{ name, lib, config, scooter, python3Packages, scooterBrokerLib, scooterWebhooksLib, broker, webhooks, ... }:

let
  inherit (lib) mkOption mkEnableOption types literalExpression;

  # Built once per service against only that service's surface: one build carrying
  # both drags scooter_webhooks_lib into the broker image. Why: PR #567.
  surfaces = {
    broker = { surface = scooterBrokerLib; entryModule = "broker_provider"; };
    webhooks = { surface = scooterWebhooksLib; entryModule = "webhooks_handler"; };
  };

  # Prefixed: a bare `ps.jira` would shadow nixpkgs' python3Packages.jira.
  contribAttrName = n:
    "scooterContrib" + lib.toUpper (lib.substring 0 1 n) + lib.substring 1 (-1) n;

  # What pythonDeps receives. Only contribs targeting this service, so depending on
  # one that does not is a missing-attribute error.
  pkgsFor = svc: python3Packages // lib.mapAttrs'
    (n: c: lib.nameValuePair (contribAttrName n) c.services.${svc}.package)
    (lib.filterAttrs (_: c: c.enable && c.services.${svc}.enable) scooter.contribs);

  # tests/ is shared across variants, so every service's deps are check inputs for
  # each one. Check-only, so the runtime closure stays per-service.
  checkDepsFor = svc: lib.concatMap (s: s.pythonDeps (pkgsFor svc))
    (lib.attrValues (lib.filterAttrs (_: s: s.enable) config.services));

  buildFor = svc:
    let s = surfaces.${svc}; in
    python3Packages.buildPythonPackage {
      # Must stay the distribution name: the metadata-check hook looks the wheel up
      # by it. Variants differ by inputs, not pname.
      pname = config.distName;
      inherit (config) version src;
      pyproject = true;
      build-system = [ python3Packages.hatchling ];

      dependencies = [ python3Packages.fastapi s.surface ]
        ++ config.services.${svc}.pythonDeps (pkgsFor svc);

      # Checked in the environment it will live in, so a bad import fails here
      # rather than at service startup.
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
          Extra deps for the ${svc} variant. Per service: a dep listed for both
          halves lands in both closures.
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
        Build this contrib and inject it into the images it targets. `false` means
        absent — no derivation at all. Build a disabled one with `withModules`
        (contrib/default.nix) rather than weakening this.
      '';
    };

    src = mkOption {
      type = types.path;
      description = "The contrib's source directory.";
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
      description = "Which services this contrib plugs into. Fixed key set, so a typo is an eval error.";
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
