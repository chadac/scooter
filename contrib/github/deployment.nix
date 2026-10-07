# github's DEPLOYMENT half. Moved out of modules/broker.nix; why: #599, #711.
{ config, lib, ... }:

let
  inherit (lib) mkOption types;
  bcfg = config.scooter.broker;
  scfg = bcfg.githubApp;
in
{
  options.scooter.broker.githubApp = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "Enable the GitHub provider, backed by a GitHub App (vends installation tokens for git/HTTPS + the API).";
    };
    appId = mkOption {
      type = types.str;
      default = "";
      description = "GitHub App ID (GITHUB_APP_ID).";
    };
    installationId = mkOption {
      type = types.str;
      default = "";
      description = "GitHub App installation ID (GITHUB_APP_INSTALLATION_ID).";
    };
    privateKeySecret = mkOption {
      type = types.submodule {
        options = {
          name = mkOption { type = types.str; description = "Secret name (in the broker namespace)."; };
          key = mkOption { type = types.str; default = "private-key"; description = "Secret key holding the PEM."; };
        };
      };
      description = "Secret holding the GitHub App private key (PEM). The secret must exist in the broker namespace.";
    };
  };

  # Needs the broker too: without it there is no container to inject env into.
  config = lib.mkIf (bcfg.enable && scfg.enable) {
    scooter.broker.extraEnv = [
      { name = "GITHUB_APP_ID"; value = scfg.appId; }
      { name = "GITHUB_APP_INSTALLATION_ID"; value = scfg.installationId; }
      {
        name = "GITHUB_APP_PRIVATE_KEY";
        valueFrom.secretKeyRef = {
          name = scfg.privateKeySecret.name;
          key = scfg.privateKeySecret.key;
        };
      }
    ];
  };
}
