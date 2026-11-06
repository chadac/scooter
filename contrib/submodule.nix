# The option preset every contrib gets. Lib-only, since only one of the three
# evals reading the schema has a `pkgs`; what a contrib builds to is derived from
# this spec by contrib/build.nix.
{ name, config, lib, ... }:

let
  inherit (lib) mkOption mkEnableOption types literalExpression;

  # The services a contrib can plug into, as names only; the packages live in
  # contrib/build.nix.
  serviceNames = [ "broker" "webhooks" ];

  # The services this contrib plugs into, in serviceNames order; the first hosts its `db`.
  hostServices = lib.filter (s: config.services.${s}.enable) serviceNames;

  # The UI surface is metadata only: a brand row and tool-card entries.
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

  # One contrib settings page. `entry` is a string, not a path, so reading the
  # registry never copies a .tsx into the store.
  settingsTabModule = {
    options = {
      id = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "${name}-accounts";
        description = ''
          The URL segment, `/settings/<id>`. Defaults to the contrib name, which is
          the right id for a contrib's only tab. A second tab must set one, and every
          id must be the contrib name or start with `${name}-`, so two contribs can
          never claim the same URL. Checked by contrib/settings-tabs.nix.
        '';
      };
      label = mkOption {
        type = types.str;
        example = "Personalization";
        description = "The tab's name in the settings sidebar.";
      };
      order = mkOption {
        type = types.int;
        default = 100;
        description = "Sort key in the sidebar. Built-in tabs take 10, 20, … 50; ties sort by id.";
      };
      entry = mkOption {
        type = types.str;
        example = "ui/SettingsTab.tsx";
        description = ''
          The section's module, relative to this contrib's directory and inside its `ui/`.
          Its default export is a React component with no props. It may import only
          @/components/*, @/lib/*, @/src/contrib/sdk and services/ui/package.json deps (an
          ESLint rule enforces this). A string so the UI build resolves it; a path
          would pull the .tsx into every eval that reads the registry.
        '';
      };
      api = mkOption {
        type = types.bool;
        default = false;
        description = ''
          Open `/contrib-api//<rest>` for this tab: the agent-host relays it to
          this contrib's broker routes at `//user/<rest>`, naming the signed-in
          user. A broker route reads that user with `scooter_broker_lib.user.user_identity`
          and must scope every query to it. Needs `services.broker.enable`. The tab calls
          it with `contribFetch` from `@/src/contrib/sdk`.
        '';
      };
    };
  };

  # A collapsible section in the right-hand panel's Session tab.
  panelModule = {
    options = {
      label = mkOption {
        type = types.str;
        example = "Shares";
        description = "The section's label.";
      };
      order = mkOption {
        type = types.int;
        default = 100;
        description = "Sort key after the built-in sections (Services, Subagents); ties sort by contrib name.";
      };
      entry = mkOption {
        type = types.str;
        example = "ui/Panel.tsx";
        description = ''
          The section's module, relative to this contrib's directory and inside its `ui/`.
          Its default export is a React component taking `PanelProps` from
          @/src/contrib/sdk. It stays mounted while the section is collapsed, so its badge
          count stays current. Same import rules as a settings tab's `entry`.
        '';
      };
      api = mkOption {
        type = types.bool;
        default = false;
        description = ''
          Open `/conversations/<id>/contrib-api/<name>/<rest>` for this panel: the
          agent-host checks the user may see the conversation, then relays to this
          contrib's broker routes at `/<name>/conversation/<shortId>/<rest>`, naming the
          user. A broker route guards itself with `scooter_broker_lib.user.user_identity`.
          Needs `services.broker.enable`. The panel calls it with `conversationFetch`.
        '';
      };
    };
  };

  # An alternate view of the app at /<id>, beside the chat view.
  viewModule = {
    options = {
      label = mkOption {
        type = types.str;
        example = "Roadmap";
        description = "The view's name in the header's view switcher.";
      };
      order = mkOption {
        type = types.int;
        default = 100;
        description = "Sort key among contrib views in the switcher, after Chat; ties sort by id.";
      };
      entry = mkOption {
        type = types.str;
        example = "ui/Roadmap.tsx";
        description = ''
          The view's module, relative to this contrib's directory and inside its `ui/`.
          Its default export is a React component with no props; it reads what it needs
          from @/src/contrib/sdk. Same import rules as a settings tab's `entry`.
        '';
      };
      api = mkOption {
        type = types.bool;
        default = false;
        description = ''
          Open the /contrib-api relays to this contrib's broker routes, for itself and per
          conversation, as a settings tab's or panel's `api` does. Needs
          `services.broker.enable`.
        '';
      };
    };
  };

  # Renders one fenced code block language in assistant messages.
  markdownFenceModule = {
    options.entry = mkOption {
      type = types.str;
      example = "ui/Embed.tsx";
      description = ''
        The renderer's module, relative to this contrib's directory and inside its `ui/`.
        Its default export is a React component taking `MarkdownFenceProps` from
        @/src/contrib/sdk. Same import rules as a settings tab's `entry`.
      '';
    };
  };

  # The card that draws one kind of request in the Approvals tab.
  interruptRendererModule = {
    options.entry = mkOption {
      type = types.str;
      example = "ui/QuestionCard.tsx";
      description = ''
        The renderer's module, relative to this contrib's directory and inside its `ui/`.
        Its default export is a React component taking `InterruptRendererProps` from
        @/src/contrib/sdk. Same import rules as a settings tab's `entry`.
      '';
    };
  };

  # One agent tool that blocks until the user answers a request of `kind`.
  blockingToolModule = {
    options = {
      kind = mkOption {
        type = types.str;
        example = "${name}.questions";
        description = ''
          The request kind the tool's input is sent as, which this contrib's
          `ui.interruptRenderers` should draw. Must start with `${name}.`.
        '';
      };
      title = mkOption {
        type = types.str;
        default = "The agent needs your input";
        description = "The request's heading, used when the renderer draws none and in the fallback card.";
      };
      dismissed = mkOption {
        type = types.str;
        default = "The user dismissed this request without answering. Do not ask again: proceed with your best judgement and say what you assumed.";
        description = "What the model is told when the user dismisses the request.";
      };
    };
  };

  uiModule = { config, ... }: {
    options = {
      enable = mkOption {
        type = types.bool;
        description = ''
          Contribute UI metadata. Defaults to true once any row below is set, so a declared row cannot
          silently render nothing; set it false to build the contrib with its UI half dropped.
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

      settingsTabs = mkOption {
        type = types.listOf (types.submodule settingsTabModule);
        default = [ ];
        example = literalExpression ''
          [{ label = "Personalization"; entry = "ui/SettingsTab.tsx"; }]
        '';
        description = ''
          Pages this contrib adds under /settings. Compiled into the main UI bundle
          as lazy chunks; the runtime manifest decides which appear, so a disabled
          contrib's tab is in the bundle but never fetched (see contrib/README.md).
          A list, not keyed by name: `contribs.<name>` already names the contrib,
          and a tab's id defaults to it.
        '';
      };

      interruptRenderers = mkOption {
        type = types.attrsOf (types.submodule interruptRendererModule);
        default = { };
        example = literalExpression ''
          { "${name}.questions" = { entry = "ui/QuestionCard.tsx"; }; }
        '';
        description = ''
          Cards this contrib draws in the Approvals tab, keyed by request kind. A
          pending request whose `kind` is listed here renders with this module
          instead of the plain option buttons, which stay underneath if it fails to
          load. Every kind must start with `${name}.`. Checked by
          contrib/interrupt-renderers.nix.
        '';
      };

      panel = mkOption {
        type = types.nullOr (types.submodule panelModule);
        default = null;
        example = literalExpression ''
          { label = "Shares"; entry = "ui/Panel.tsx"; api = true; }
        '';
        description = "This contrib's section in the right-hand panel's Session tab. Checked by contrib/conversation-ui.nix.";
      };

      views = mkOption {
        type = types.attrsOf (types.submodule viewModule);
        default = { };
        example = literalExpression ''
          { roadmap = { label = "Roadmap"; entry = "ui/Roadmap.tsx"; api = true; }; }
        '';
        description = ''
          Alternate views this contrib adds beside the chat view, keyed by id: the view owns
          everything below the header at `/<id>/*`, and reads the path below it with
          `useViewRoute()`. An id may not shadow a route the app or its proxy already
          serves. Checked by contrib/conversation-ui.nix.
        '';
      };

      markdownFences = mkOption {
        type = types.attrsOf (types.submodule markdownFenceModule);
        default = { };
        example = literalExpression ''
          { "scooter-embed" = { entry = "ui/Embed.tsx"; }; }
        '';
        description = ''
          Fenced code blocks this contrib renders in assistant messages, keyed by the
          fence's language. A block whose language no enabled contrib claims renders as
          code. Two contribs may not claim one language. Checked by
          contrib/conversation-ui.nix.
        '';
      };
    };

    config.enable = lib.mkDefault
      (config.source != null || config.tools != { } || config.settingsTabs != [ ] || config.interruptRenderers != { }
        || config.panel != null || config.markdownFences != { } || config.views != { });
  };

  # One recurring task this contrib ships, built by mkScooterTask (contrib/tasks.nix)
  # and mapped into the platform's `scooter.systemTasks."<contrib>-<id>"`.
  systemTaskModule = { ... }: {
    options = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = "Ship this task. An operator can also turn it off at `scooter.systemTasks.\"${name}-<id>\".enable`.";
      };
      entry = mkOption {
        type = types.str;
        example = "scooter_contrib_${name}.tasks.refresh:main";
        description = ''
          `<module>:<command>`, a click command decorated with `scooter_task.task`
          (lib/py/scooter-task), importable from this contrib's source directory.
        '';
      };
      pythonDeps = mkOption {
        type = types.functionTo (types.listOf types.package);
        default = _: [ ];
        example = literalExpression "ps: [ ps.pyyaml ]";
        description = "Python packages the task needs beyond scooter-lib, scooter-task and click.";
      };
      args = mkOption {
        type = types.listOf types.str;
        default = [ ];
        example = literalExpression ''[ "--prompt-file" "''${./prompts/refresh.md}" ]'';
        description = "The task's arguments. A store path here ships in the scheduler image with the task.";
      };
      every = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "1h";
        description = "Run every this long (`<n>s|m|h|d`). Exactly one of `every` and `cron`.";
      };
      cron = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "0 9 * * 1";
        description = "Run on this cron schedule, in `timezone`. Exactly one of `every` and `cron`.";
      };
      timezone = mkOption {
        type = types.str;
        default = "UTC";
        description = "The timezone `cron` is read in.";
      };
      timeout = mkOption {
        type = types.str;
        default = "10m";
        description = "SIGTERM after this long (`<n>s|m|h|d`), then SIGKILL 30s later.";
      };
      model = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "The model the task's conversations default to; null is the deployment's fast model.";
      };
    };
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

      env = mkOption {
        type = types.attrsOf (types.either types.str
          (types.submodule {
            options = {
              name = mkOption { type = types.str; description = "Secret name."; };
              key = mkOption { type = types.str; description = "Key within the Secret."; };
            };
          }));
        default = { };
        example = literalExpression ''
          { EXAMPLE_URL = config.url; EXAMPLE_TOKEN = config.tokenSecret; }
        '';
        description = ''
          Env the ${svc} container gets while this contrib is enabled and ${svc} is
          deployed. A string is the value; a `{ name; key; }` (what
          contrib/lib.nix's `mkSecretOption` holds) is a secretKeyRef. Rendered by
          modules/contrib-env.nix. Use `lib.mkIf` to leave a variable unset.
        '';
      };
    } // lib.optionalAttrs (svc == "broker") {
      publicPaths = mkOption {
        type = types.listOf (types.strMatching "/[A-Za-z0-9._~-]+/");
        default = [ ];
        example = [ "/s/" ];
        description = ''
          Path prefixes on the public origin that go straight to this contrib's broker
          routes, unauthenticated, e.g. `/s/` for published shares. The UI's nginx
          proxies each one to the broker, and with `scooter.ui.enable = false` the
          Ingress routes it there instead. Each prefix needs its own routes on the
          broker (`Provider(mount_at_root=True)`), and two contribs may not claim the same one.
        '';
      };
      notifyAwaitingInput = mkOption {
        type = types.bool;
        default = false;
        description = ''
          Tell this contrib's broker half whenever a conversation starts waiting on the
          user: a question the agent asked, or an approval. The agent-host POSTs each
          pending interrupt, with the conversation's links and URL, to
          `/<contrib>/awaiting-input`, so the contrib can surface it where the user is,
          e.g. the Slack thread the conversation came from. Delivery is best-effort.
        '';
      };
    };
  };
in
{
  options = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Build this contrib and inject it into the images it targets. `false` means
        absent: no derivation, nothing in any image, and no skills. Its deployment
        options are still DECLARED — the platform imports every contrib (#719) — but
        setting one fails the render rather than being silently ignored, because
        `shipGate` in modules/platform.nix throws on a contrib configured but not
        shipped (#599). Setting this false alone is always legal — that is how a
        deployment trims the contrib set.

        OPT IN, not out. Defaulting true meant a deployment had to enumerate every
        integration it did NOT want, and five of them declare a credential with no
        default — so forgetting one failed the render instead of shipping nothing.
        mkDefault, so a deployment may still set it either way without mkForce.
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

    agent = mkOption {
      default = { };
      description = "What this contrib changes about how the agent runs.";
      type = types.submodule {
        options.blockingTools = mkOption {
          type = types.attrsOf (types.submodule blockingToolModule);
          default = { };
          example = literalExpression ''
            { AskUserQuestion = { kind = "${name}.questions"; title = "The agent has a question"; }; }
          '';
          description = ''
            Agent tools that block until the user answers, keyed by the tool's name.
            The Claude provider sends the call's input as a request of `kind`, waits,
            and merges the user's result object into the tool's input. Rendered into
            the agent-host's `BLOCKING_TOOLS_JSON` by modules/platform.nix.
          '';
        };
        options.hooks = mkOption {
          type = types.attrsOf (types.submodule (import ./hook-module.nix { inherit lib; }));
          default = { };
          description = ''
            Conversation hooks this contrib adds, keyed by id; the agent-host sees them as
            `${name}.<id>`. Same schema as `scooter.agent.hooks`.
          '';
        };
        options.skillProviders = mkOption {
          type = types.attrsOf (types.submodule (import ./skill-provider-module.nix { inherit lib; }));
          default = { };
          description = ''
            Skill providers this contrib adds, keyed by id; the agent-host sees them as
            `${name}.<id>`. Same schema as `scooter.agent.skillProviders`.
          '';
        };
      };
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

    links.typeAliases = mkOption {
      type = types.attrsOf types.str;
      default = { };
      example = { pr = "pull_request"; pull_request = "pull_request"; };
      description = ''
        Every `resourceType` spelling this contrib's links use, mapped to the one
        stored in `resource_links`. The agent-host canonicalises links posted to it
        (the broker's auto-links, `agent-broker link add`) with this table, so a link
        and the same resource from the webhooks handler land on one row. Rendered
        into the agent-host's `LINK_TYPE_ALIASES_JSON` by modules/platform.nix; a
        source with no table is stored as written.
      '';
    };

    db = mkOption {
      default = { };
      description = ''
        This contrib's OWN Postgres database, holding the tables it wholly owns, with
        its own Atlas migration history under `<src>/sql` (`schema.sql` +
        `migrations/`). The platform derives the rest from this: the
        `scooter.db.<db.name>` spec entry, the database itself (owned by the host
        service's existing role, so no new user or Secret), the migrator env, and
        `CONTRIB_<NAME>_DB_NAME` on the host pod. A contrib reaches it through
        `BrokerContext.contrib_store_config("<name>")`.

        Tables a contrib only reads or writes but does not own stay in core.
      '';
      type = types.submodule {
        options = {
          enable = mkEnableOption "a database owned by this contrib";
          name = mkOption {
            type = types.str;
            default = "contrib_${builtins.replaceStrings [ "-" ] [ "_" ] name}";
            defaultText = literalExpression ''"contrib_''${name}"'';
            description = "Database name (also the Atlas env name).";
          };
          owner = mkOption {
            type = types.nullOr types.str;
            default = null;
            example = "agent-host";
            description = ''
              The service whose existing role owns this database and runs its
              migrations: any `scooter.postgres.consumers` key, e.g. `agent-host`.
              `null` means the first of `broker`, `webhooks` this contrib plugs into.
            '';
          };
          provides = mkOption {
            type = types.listOf (types.enum [ "awaiting-input" ]);
            default = [ ];
            description = ''
              Core features this database backs. Each puts `<FEATURE>_DB_NAME` (e.g.
              `AWAITING_INPUT_DB_NAME`) on every pod with access, so core finds the
              database without naming the contrib. At most one contrib may provide each.
              `awaiting-input`: table `conversation_awaiting_input (conversation_id, since)`,
              NOTIFY `conversation_awaiting_input_changed` with `{"conversationId"}`.
            '';
          };
          tables = mkOption {
            default = { };
            description = ''
              The tables in this database, keyed by name. Must match the
              `CREATE TABLE`s in `<src>/sql/schema.sql` (ownership.spec.ts checks).
            '';
            type = types.attrsOf (types.submodule {
              options = {
                writers = mkOption {
                  type = types.listOf types.str;
                  default = hostServices;
                  defaultText = literalExpression "the services this contrib plugs into";
                  description = "Services that write this table (see `scooter.db`).";
                };
                readers = mkOption {
                  type = types.listOf types.str;
                  default = [ ];
                  description = ''
                    Services granted SELECT only (see `scooter.db`). A service other
                    than the owner gets table-scoped grants on its own role.
                  '';
                };
                note = mkOption {
                  type = types.nullOr types.lines;
                  default = null;
                  description = "Rendered as a comment above the table in owners.toml.";
                };
                copyFrom = mkOption {
                  type = types.nullOr types.str;
                  default = null;
                  example = "broker";
                  description = ''
                    A one-time move: the database that held this table before the
                    contrib had its own. After migrating, the migrator copies the old
                    rows in when this table is EMPTY and the source table EXISTS, and
                    skips otherwise, so re-runs and fresh installs are no-ops. Both
                    databases must share an owner role. Remove it in the same change
                    that drops the source table.
                  '';
                };
              };
            });
          };
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

        Gated on `enable` above: they ship only where this contrib is BUILT. A
        skill for an integration no image contains teaches the agent to call a
        route that 404s, and then to read that 404 as the feature being broken.

        Deployment config does NOT gate them — an agent should know an
        integration's interface even where this deployment has not wired it, and
        a 404 then means "not enabled here", which is the broker's answer to
        give rather than a gap in the agent's knowledge.

        Paths, not strings: the file stays a readable .md next to the code it
        documents, and modules/platform.nix reads it straight off `config.contribs`.
      '';
    };

    skillDirs = mkOption {
      default = { };
      example = literalExpression ''
        {
          marimo-pair = {
            source = "github:marimo-team/marimo-pair";
            dir = "skills/marimo-pair";
          };
        }
      '';
      description = ''
        Skill DIRECTORIES this contrib adds to the platform's `skillDirs`
        (modules/skills) when it is enabled. Same shape as `skillDirs.<name>`;
        see there for how a directory reaches the agent and the sandbox.
      '';
      type = types.attrsOf (types.submodule ../modules/skills/dir.nix);
    };

    systemTasks = mkOption {
      type = types.attrsOf (types.submodule systemTaskModule);
      default = { };
      example = literalExpression ''
        {
          refresh-profile = {
            entry = "scooter_contrib_${name}.tasks.refresh:main";
            args = [ "--prompt-file" "''${./prompts/refresh.md}" ];
            every = "1h";
          };
        }
      '';
      description = ''
        Recurring tasks the scheduler runs for this contrib, keyed by id. Each is
        built from this contrib's source with mkScooterTask and lands in the
        platform as `scooter.systemTasks."${name}-<id>"`, where an operator can
        tune or disable it. See lib/py/scooter-task for how to write one.
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
