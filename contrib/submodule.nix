# The option preset every contrib gets, plus its build.
#
# A module, so a contrib's own `options` merge in. `scooter` is the parent
# config: every other contrib, already evaluated. Why: PR #585.
{ name, lib, config, scooter, python3Packages, scooterBrokerLib, scooterWebhooksLib, broker, webhooks, ... }:

let
  inherit (lib) mkOption mkEnableOption types literalExpression;

  # Built once per service against only that service's surface: one build carrying
  # both drags scooter_webhooks_lib into the broker image. Why: PR #567.
  surfaces = {
    broker = { surface = scooterBrokerLib; entryModule = "broker_provider"; };
    webhooks = { surface = scooterWebhooksLib; entryModule = "webhooks_handler"; };
  };

  # What pythonDeps receives. Nested so contribs cannot shadow nixpkgs
  # (python3Packages.jira is the Jira client), and holds only contribs targeting
  # this service, so naming one that does not is an error.
  pkgsFor = svc: python3Packages // {
    scooterContrib = lib.mapAttrs (_: c: c.services.${svc}.package)
      (lib.filterAttrs (_: c: c.enable && c.services.${svc}.enable) scooter.contribs);
  };

  # tests/ is shared across variants, so every service's deps are check inputs for
  # each one. Check-only, so the runtime closure stays per-service.
  checkDepsFor = svc: lib.concatMap (s: s.pythonDeps (pkgsFor svc))
    (lib.attrValues (lib.filterAttrs (_: s: s.enable) config.services));

  buildFor = svc:
    let s = surfaces.${svc}; in
    assert lib.assertMsg (config.src != null)
      "contrib ${name}: services.${svc}.enable is set but `src` is not — a service half needs a source directory.";
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

  iconPacks = import ./ui-icon-packs.nix;

  # Tier 1 of the UI surface: METADATA only -- a brand row and tool-card entries
  # the app already keys off a hardcoded name. A contrib shipping React
  # components (a RightPanel tab) is tier 2 and lands with the first feature
  # that needs one. Why: PR #601.
  iconModule = {
    options = {
      pack = mkOption {
        type = types.enum (lib.attrNames iconPacks);
        example = "si";
        description = "Which react-icons pack the icon comes from.";
      };
      name = mkOption {
        type = types.strMatching "[A-Z][A-Za-z0-9]+";
        example = "SiGrafana";
        description = ''
          The exported component name. Checked for shape here and for EXISTENCE by
          tsc when the UI compiles the generated manifest, so a typo is a build
          error rather than a missing glyph.
        '';
      };
    };
  };

  sourceModule = {
    options = {
      label = mkOption {
        type = types.str;
        example = "GitLab";
        description = "Human name for this contrib's resources.";
      };
      icon = mkOption {
        type = types.submodule iconModule;
        description = "The brand mark, drawn from a pack the UI already bundles.";
      };
      color = mkOption {
        type = types.str;
        default = "currentColor";
        description = ''
          Brand color for the mark. `currentColor` inherits the theme -- use it for
          a mark whose brand color vanishes in one of the two themes.
        '';
      };
      linkProvider = mkOption {
        type = types.bool;
        default = false;
        description = ''
          Whether this source is a linked-resource provider, hence offered as a
          sidebar filter chip and a "Show:" label mode. False for a contrib that
          only renders tool cards.
        '';
      };
    };
  };

  toolModule = {
    options = {
      argKey = mkOption {
        type = types.str;
        example = "body";
        description = "Which tool argument holds the text the card shows.";
      };
      action = mkOption {
        type = types.str;
        example = "commented on GitLab";
        description = "Short verb for the card header.";
      };
      titles = mkOption {
        type = types.listOf types.str;
        default = [ ];
        example = literalExpression ''[ "Comment on the GitLab MR" ]'';
        description = ''
          The tool's registerTool `title`s, accepted as a fallback: some ACP paths
          surface the title instead of the "<server>: <Name>" form. Matched
          case-insensitively.
        '';
      };
    };
  };

  # Tier 2: a contrib ships real React. The component is COMPILED INTO the UI
  # bundle -- there is no runtime module loader -- so `entry` is a path the
  # manifest build copies into the UI source tree. Why: PR #602.
  panelModule = {
    options = {
      id = mkOption {
        type = types.strMatching "[a-z][a-z0-9-]*";
        example = "shares";
        description = "Tab id. Must not collide with another panel's or a built-in tab's.";
      };
      title = mkOption {
        type = types.str;
        example = "Shares";
        description = "Tab label.";
      };
      entry = mkOption {
        type = types.path;
        example = literalExpression "./ui/SharesPanel.tsx";
        description = ''
          A .tsx module exporting `usePanel()`, which returns the tab's
          visibility, its count badge and its body. ONE hook rather than a
          component plus a separate badge selector, so a panel with a
          subscription (a poll, a socket) opens it once instead of once per
          consumer. Checked against ContribPanel by tsc when the UI compiles.
        '';
      };
      order = mkOption {
        type = types.int;
        default = 50;
        description = ''
          Tab position among the contrib panels, ascending; ties break on id so
          the order never depends on attrset iteration. Contrib tabs always sit
          after the app's own.
        '';
      };
    };
  };

  uiModule = { config, ... }: {
    options = {
      enable = mkOption {
        type = types.bool;
        description = ''
          Contribute UI metadata. Defaults to true once `source` or `tools` is
          set, so a declared row cannot silently render nothing; set it false to
          build the contrib with its UI half dropped.
        '';
      };

      source = mkOption {
        type = types.nullOr (types.submodule sourceModule);
        default = null;
        description = ''
          This contrib's row in the UI's source table -- the label, brand icon and
          color shown for its linked resources and tool cards. Keyed by the
          contrib name.
        '';
      };

      tools = mkOption {
        type = types.attrsOf (types.submodule toolModule);
        default = { };
        example = literalExpression ''
          { gitlab_comment = { argKey = "body"; action = "commented on GitLab"; }; }
        '';
        description = ''
          How this contrib's agent tools render as message cards, keyed by tool
          NAME (the identity the UI normalizes an incoming call down to).
        '';
      };

      panels = mkOption {
        type = types.listOf (types.submodule panelModule);
        default = [ ];
        description = ''
          Right-panel tabs this contrib adds. Each is real React compiled into
          the bundle, so it may import only the pinned `@scooter/ui-kit` surface
          -- a contrib cannot add an npm dependency.
        '';
      };
    };

    config.enable = lib.mkDefault (config.source != null || config.tools != { } || config.panels != [ ]);
  };

  serviceModule = svc: { ... }: {
    options = {
      enable = mkEnableOption "the ${svc} half of this contrib";

      pythonDeps = mkOption {
        type = types.functionTo (types.listOf types.package);
        default = _: [ ];
        example = literalExpression "ps: [ ps.httpx ps.scooterContrib.jira ]";
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
      type = types.nullOr types.path;
      default = null;
      description = ''
        The contrib's Python source directory. Optional: a contrib may contribute
        only UI, in which case it builds no package at all. Required as soon as
        any `services.<svc>.enable` is set -- asserted at build, since a service
        half with nothing to build is a typo, not a configuration.
      '';
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

    ui = mkOption {
      default = { };
      type = types.submodule uiModule;
      description = ''
        What this contrib contributes to the frontend. Compiled INTO the UI
        bundle (the icons are React components and the UI is a static build), so
        it reaches a deployment through contrib/ui-manifest.nix rather than a
        runtime API.
      '';
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
