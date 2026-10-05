# The option preset every contrib gets. Why: PR #585.
#
# `lib`-only: the schema is read by three evals and only one of them has a `pkgs`
# (see contrib/spec.nix). What a contrib BUILDS TO is therefore not an option here —
# contrib/build.nix derives it from this spec, which is also what lets the kubenix
# eval import a contrib without resolving a single derivation. Why: #711.
{ name, lib, ... }:

let
  inherit (lib) mkOption mkEnableOption types literalExpression;

  # The services a contrib can plug into. NAMES only — the surface package and
  # entry-point module each one builds against live in contrib/build.nix, because
  # they are packages and this file may not force one.
  serviceNames = [ "broker" "webhooks" ];

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

          Receives nixpkgs' python packages plus `scooterContrib.<name>` — the other
          contribs targeting THIS service, nested so a contrib cannot shadow nixpkgs
          (python3Packages.jira is the Jira client). Applied by contrib/build.nix,
          which is the only place a package is resolved.
        '';
      };
    };
  };
in
{
  options = {
    enable = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Build this contrib and inject it into the images it targets. `false` means
        absent — no derivation at all, and no options either: the platform drops a
        disabled contrib before importing it, so configuring one is an eval error
        rather than a block that is silently ignored (#599).

        Build a disabled one with `withModules` (contrib/default.nix) rather than
        weakening this.
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

    approvals = mkOption {
      default = null;
      description = ''
        This contrib raises HUMAN APPROVALS: the agent asks for something, a person
        answers Approve/Deny in the conversation, and the answer is relayed back to
        the contrib's broker half. `null` (the default) means it raises none.

        The platform deliberately learns only how to REACH this contrib's verbs —
        never what it is approving. The prose a human reads is rendered by the
        contrib and arrives already-formed, so adding an integration with a
        different notion of "risk" needs no platform change.

        This is the PRESENTATION half, and it is build-time metadata: it rides the
        contrib manifest into the UI image. Where the contrib's verbs actually live
        on the broker is DEPLOYMENT config — an operator can run the same contrib
        against a differently-mounted broker — so it is declared by the contrib's
        platform module as `scooter.approvals.<name>`, which is also already
        gated on that deployment enabling the contrib.

        Neither fact is stated twice; they simply belong to different lifecycles.
      '';
      type = types.nullOr (types.submodule {
        options = {
          gatedOption = mkOption {
            type = types.str;
            default = "approve";
            description = ''
              Which option id the per-viewer authorization check gates. Only this one
              is greyed for a viewer the broker says may not act; the others (Deny,
              typically) stay live, because refusing is not a privileged action.
            '';
          };
          blockedTitle = mkOption {
            type = types.str;
            default = "You need an admin to approve this request.";
            description = "Tooltip on the gated option when this viewer may not use it.";
          };
          blockedHint = mkOption {
            type = types.str;
            default = "You don't have permission to approve this — an admin must.";
            description = "Text shown under the options when this viewer may not use the gated one.";
          };
        };
      });
    };

    skills = mkOption {
      type = types.attrsOf types.path;
      default = { };
      example = literalExpression ''{ "scooter-aws.md" = ./skills/scooter-aws.md; }'';
      description = ''
        Agent skills documenting this contrib, keyed by the filename the agent sees.

        Gated on THIS CONTRIB'S NAME: they ship only where
        `scooter.broker.<name>.enable` is true, so a contrib shipping skills
        must have a broker option of the same name (platform.nix throws otherwise).
        A skill for an integration that is off teaches the agent to call a route
        that 404s, and then to read that 404 as the feature being broken.

        Paths, not strings: the file stays a readable .md next to the code it
        documents, and modules/platform.nix reads it straight off `config.contribs`.
      '';
    };

    services = mkOption {
      default = { };
      description = "Which services this contrib plugs into. Fixed key set, so a typo is an eval error.";
      type = types.submodule {
        options = lib.genAttrs serviceNames (svc: mkOption {
          type = types.submodule (serviceModule svc);
          default = { };
          description = "The ${svc} half of this contrib.";
        });
      };
    };
  };
}
