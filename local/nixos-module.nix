# nixosModules.local: Scooter on a NixOS machine, declared.
#
#   services.scooter-local = {
#     enable = true;
#     settings.scooter.local.provider = "ollama";
#     environmentFile = "/run/secrets/scooter-local";   # OLLAMA_MODEL=…, or the token/key
#   };
#
# Enables Docker, installs the `scooter-local` built for `settings`, and runs `up` as a
# systemd service (`down` on stop). The docs: "Local deployments".
{ mkLocal }:
{ config, lib, pkgs, ... }:
let
  inherit (lib) mkOption mkEnableOption mkIf mkDefault types literalExpression;
  cfg = config.services.scooter-local;
in
{
  options.services.scooter-local = {
    enable = mkEnableOption "Scooter on this machine: a k3d cluster running the published images";

    settings = mkOption {
      type = types.deferredModule;
      default = { };
      example = literalExpression ''
        {
          scooter.local.provider = "anthropic";
          scooter.agent.availableModels.goose."claude-opus-5-5".default = true;
          contribs.github.enable = true;
        }
      '';
      description = ''
        The platform configuration on top of the local preset (local/preset.nix):
        the provider under `scooter.local`, and anything else under `scooter.*` or
        `contribs.*`. Rendered at build time into `package`.
      '';
    };

    package = mkOption {
      type = types.package;
      default = mkLocal { system = pkgs.stdenv.hostPlatform.system; module = cfg.settings; };
      defaultText = literalExpression "scooter.lib.mkLocal { module = cfg.settings; }";
      description = "The `scooter-local` the service runs; built from `settings` by default.";
    };

    environmentFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      example = "/run/secrets/scooter-local";
      description = ''
        A systemd EnvironmentFile with the credential `up` would otherwise ask for:
        `CLAUDE_CODE_OAUTH_TOKEN=…` (claude-code), `ANTHROPIC_API_KEY=…` (anthropic),
        or `OLLAMA_MODEL=…` (ollama, unless `settings` sets `scooter.local.ollama.model`).
        Outside the Nix store. The service has no terminal, so it fails with a message
        if a needed value is missing.
      '';
    };

    port = mkOption {
      type = types.port;
      default = 8080;
      description = "The UI's port on localhost (SCOOTER_LOCAL_PORT).";
    };

    stateDir = mkOption {
      type = types.str;
      default = "/var/lib/scooter-local";
      description = "The kubeconfig, the chosen provider and the uploads (SCOOTER_LOCAL_STATE).";
    };

    docker.enable = mkOption {
      type = types.bool;
      default = true;
      description = "Enable `virtualisation.docker`; k3d runs the cluster in Docker.";
    };
  };

  config = mkIf cfg.enable {
    virtualisation.docker.enable = mkIf cfg.docker.enable (mkDefault true);
    environment.systemPackages = [ cfg.package ];

    systemd.services.scooter-local = {
      description = "Scooter on this machine (k3d)";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ] ++ lib.optional cfg.docker.enable "docker.service";
      requires = lib.optional cfg.docker.enable "docker.service";
      # docker for k3d; nix for the one eval `up` may run (the claude image tag).
      path = [ config.nix.package ] ++ lib.optional cfg.docker.enable config.virtualisation.docker.package;
      environment = {
        SCOOTER_LOCAL_STATE = cfg.stateDir;
        SCOOTER_LOCAL_PORT = toString cfg.port;
        HOME = cfg.stateDir;
      };
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = "${lib.getExe cfg.package} up";
        ExecStop = "${lib.getExe cfg.package} down";
        EnvironmentFile = mkIf (cfg.environmentFile != null) [ cfg.environmentFile ];
        # The first `up` pulls the images.
        TimeoutStartSec = "45min";
        TimeoutStopSec = "5min";
        StateDirectory = mkIf (lib.hasPrefix "/var/lib/" cfg.stateDir) (lib.removePrefix "/var/lib/" cfg.stateDir);
      };
    };
  };
}
