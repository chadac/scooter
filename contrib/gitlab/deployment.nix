# gitlab's DEPLOYMENT half. Moved out of modules/broker.nix; why: #599, #711.
{ config, lib, ... }:

let
  inherit (lib) mkOption types;
  bcfg = config.scooter.broker;
  scfg = bcfg.gitlab;
in
{
  options.scooter.broker.gitlab = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "Enable the GitLab provider (transparent http-proxy to gitlab.com with the token injected).";
    };
    tokenSecret = mkOption {
      type = types.submodule {
        options = {
          name = mkOption { type = types.str; description = "Secret name (in the broker namespace)."; };
          key = mkOption { type = types.str; default = "GITLAB_TOKEN"; description = "Secret key holding the GitLab token."; };
        };
      };
      description = "Secret holding the GitLab token (glpat-…). Injected as GITLAB_TOKEN. The secret must exist in the broker namespace.";
    };
  };

  # Needs the broker too: without it there is no container to inject env into.
  config = lib.mkIf (bcfg.enable && scfg.enable) {
    scooter.broker.extraEnv = [
      {
        name = "GITLAB_TOKEN";
        valueFrom.secretKeyRef = {
          name = scfg.tokenSecret.name;
          key = scfg.tokenSecret.key;
        };
      }
    ];
  };
}
