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

  # Tier 1 of the UI surface: METADATA only -- a brand row and tool-card entries
  # the app already keys off a hardcoded name. A contrib shipping React
  # components (a RightPanel tab) is tier 2 and lands with the first feature
  # that needs one. Why: PR #601.
  sourceModule = {
    options = {
      label = mkOption {
        type = types.str;
        example = "GitLab";
        description = "Human name for this contrib's resources.";
      };
      icon = mkOption {
        type = types.path;
        example = literalExpression "./icon.svg";
        description = ''
          The brand mark, as an SVG file in this contrib's own directory: a viewBox
          and a single <path d=…>, which contrib/ui-manifest.nix reads into the
          runtime manifest. A file rather than an icon-pack name because the
          manifest is fetched at runtime — resolving a name in the browser would
          mean bundling a whole react-icons pack. Simple Icons (CC0) is a good
          source.
        '';
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
    };

    config.enable = lib.mkDefault (config.source != null || config.tools != { });
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

    ui = mkOption {
      default = { };
      type = types.submodule uiModule;
      description = ''
        What this contrib contributes to the frontend. Rendered into the runtime
        manifest the UI fetches (contrib/ui-manifest.nix), so changing a
        deployment's contrib set needs no UI rebuild.
      '';
    };

    sandbox = mkOption {
      default = { };
      description = "What this contrib adds to the agent's sandbox image.";
      type = types.submodule {
        options.module = mkOption {
          type = types.nullOr types.path;
          default = null;
          example = literalExpression "./sandbox.nix";
          description = ''
            A NixOS module layered into the sandbox image — packages, systemd units,
            activation, anything NixOS offers. `null` means this contrib adds nothing
            to the sandbox.

            Must live inside the repo: the in-pod re-converge rebuilds the system from
            a vendored copy of it, so a module reached from outside would be in the
            image and missing from a `scooter-rebuild switch`. Anything the module
            refers to relatively (`../../pkgs/…`) resolves the same on both sides.
          '';
        };
      };
    };

    deployment = mkOption {
      default = { };
      description = "What this contrib adds to the platform's kubenix manifests.";
      type = types.submodule {
        options.module = mkOption {
          type = types.nullOr types.path;
          default = null;
          example = literalExpression "./deployment.nix";
          description = ''
            A kubenix module layered into the platform eval (modules/platform.nix
            imports it) — where this contrib declares its OWN deployment options
            and renders its own manifests. `null` means it adds nothing.

            Not per-service, unlike `services.<svc>`: one module, free to touch any
            option the platform declares, because a contrib with both a broker and a
            webhooks half still has ONE set of deployment knobs. It reaches into a
            service's Deployment through that service's seams
            (agentSandbox.broker.extraEnv and friends) and renders anything of its
            own straight into kubernetes.resources.

            Gets `{ config, lib, ... }` and NOTHING built: contrib/deployment-modules.nix
            is lib-only because an external deployer imports platform.nix with no
            `pkgs` to build a contrib's Python half with. A module forcing a package
            arg is an eval error. Same constraint as `sandbox.module` (#607) and
            `skills` (#618), for the same reason.

            A contrib shipping `skills` must declare `agentSandbox.broker.<name>.enable`
            here — that option IS the gate platform.nix ships its skills on.
          '';
        };
      };
    };

    skills = mkOption {
      type = types.attrsOf types.path;
      default = { };
      example = literalExpression ''{ "scooter-aws.md" = ./skills/scooter-aws.md; }'';
      description = ''
        Agent skills documenting this contrib, keyed by the filename the agent sees.

        Gated on THIS CONTRIB'S NAME: they ship only where
        `agentSandbox.broker.<name>.enable` is true, so a contrib shipping skills
        must have a broker option of the same name (platform.nix throws otherwise).
        A skill for an integration that is off teaches the agent to call a route
        that 404s, and then to read that 404 as the feature being broken.

        Paths, not strings: the file stays a readable .md next to the code it
        documents, and the platform module reads it (contrib/skills.nix).
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
