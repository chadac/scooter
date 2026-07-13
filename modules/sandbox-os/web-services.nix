# services.webServices.<name> — declarative in-pod web services the platform
# reverse-proxies at https://<host>/c/<id>/<name>/ (marimo, web VS Code, xterm…).
#
# DESIGN BOILERPLATE (PoC stage 2). Signatures + rendered-output contract only —
# no working ExecStart bodies yet (built-ins land in web-services/<name>.nix, and
# the lazy-tool packaging is wired in implementation). See docs/WEB_SERVICES_PROXY.md.
#
# The option is the single source of truth for BOTH:
#   1. the systemd unit `webservice-<name>` that runs the service, AND
#   2. the discovery manifest `/run/scooter/web-services.json` the agent-host reads
#      to learn <name> -> in-pod port (so the proxy knows where to forward).
#
# Explicit-start model: units are NOT wantedBy multi-user.target — the agent or the
# user (UI Start button -> agent-host -> `systemctl start webservice-<name>` via
# exec) starts them on demand. The proxy only routes.

{ config, lib, pkgs, ... }:

let
  cfg = config.services.webServices;

  # The discovery manifest the agent-host reads (via exec/download) to resolve
  # <name> -> { port, displayName, basePath, running? }. Rendered from the enabled
  # services. SHAPE (contract with the agent-host WebServiceRegistry):
  #   { "services": [ { "name", "displayName", "port", "basePath", "unit" }, ... ] }
  # `running` is NOT in the manifest (it's static config); the agent-host derives
  # liveness separately (systemctl is-active via exec) when the UI asks.
  manifest = null; # TODO(impl): pkgs.writeText "web-services.json" (builtins.toJSON { services = ...; });

  # Per-service systemd unit name. Kept stable + prefixed so the agent-host can
  # `systemctl start/stop webservice-<name>` deterministically.
  unitName = name: "webservice-${name}";

  serviceOpts = { name, ... }: {
    options = {
      enable = lib.mkEnableOption "the ${name} web service";

      port = lib.mkOption {
        type = lib.types.port;
        description = ''
          In-pod TCP port the service listens on (bound to 0.0.0.0 so the
          agent-host can reach it at podIP:port). Must be unique across enabled
          services.
        '';
      };

      command = lib.mkOption {
        type = lib.types.str;
        description = ''
          ExecStart command line. For built-ins this points at a LAZY-TOOL stub on
          PATH (e.g. `marimo`), so the closure builds on first start and the base
          image stays small. The command MUST make the service serve under its
          basePath (e.g. marimo `--base-url ${"$"}{basePath} --proxy <host>`).
        '';
      };

      displayName = lib.mkOption {
        type = lib.types.str;
        default = name;
        description = "Human label shown in the UI Services panel.";
      };

      basePath = lib.mkOption {
        type = lib.types.str;
        default = "/c/\${CONVERSATION_ID}/${name}";
        description = ''
          The external sub-path this service is served under. The conversation id
          comes from the CONVERSATION_ID env var the provisioner injects at pod
          creation (alongside CONVERSATION_URL) — the unit's ExecStart expands it
          at start time, so no proxy-side templating is needed. The service must be
          configured to emit links/assets under this prefix (e.g. marimo
          `--base-url ${"$"}{basePath}`).
        '';
      };

      user = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Run as this user; null => DynamicUser. Marimo/VS Code need a real HOME + workspace, so built-ins set a concrete user.";
      };

      environment = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        default = { };
        description = "Extra environment for the unit.";
      };
    };
  };
in
{
  imports = [
    # Built-in service definitions (each sets services.webServices.<name> defaults
    # + its lazy-tool). Enabled individually by the deployment/agent module.
    # ./web-services/marimo.nix   # TODO(impl) — proven first
    # ./web-services/xterm.nix    # TODO(impl)
    # ./web-services/vscode.nix   # TODO(impl)
  ];

  options.services.webServices = lib.mkOption {
    type = lib.types.attrsOf (lib.types.submodule serviceOpts);
    default = { };
    description = "Declarative in-pod web services, reverse-proxied at /c/<id>/<name>/.";
  };

  config = lib.mkIf (cfg != { }) {
    # TODO(impl): for each enabled service render
    #   systemd.services.${unitName name} = {
    #     description = "web service: ${svc.displayName}";
    #     # NOT wantedBy multi-user.target — explicit start.
    #     serviceConfig = {
    #       ExecStart = svc.command;
    #       Restart = "on-failure";
    #       RestartIfChanged = false;   # survive a live switch-to-configuration
    #     } // (if svc.user != null then { User = svc.user; } else { DynamicUser = true; });
    #     environment = svc.environment;
    #   };
    #
    # TODO(impl): render the discovery manifest to /run/scooter/web-services.json
    #   via a tmpfiles rule or a oneshot, from `manifest` above.
    assertions = [
      # TODO(impl): assert unique ports across enabled services.
    ];
  };
}
