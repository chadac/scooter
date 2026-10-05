# kagi's DEPLOYMENT half: the options an operator sets, and the broker env they
# render. A kubenix module in the same eval as modules/platform.nix, found beside
# ./contrib.nix. See contrib/brave/deployment.nix for the pattern and the one rule
# (no bare sibling-contrib reads).
{ config, lib, ... }:

let
  inherit (lib) mkOption types;
  bcfg = config.scooter.broker;
  scfg = bcfg.kagi;
in
{
  options.scooter.broker.kagi = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Enable the Kagi Search provider, which serves the agent's `kagi_web_search`
        tool.

        Better human-facing ranking than brave, at $12/1k requests with no free tier
        and a paid Kagi account required — and an LLM reranking the results erases much
        of that difference, so prefer `brave` unless you already pay for Kagi.
        Combinable with `brave` and `duckduckgo`.
      '';
    };
    apiKeySecret = mkOption {
      type = types.submodule {
        options = {
          name = mkOption { type = types.str; description = "Secret name (in the broker namespace)."; };
          key = mkOption { type = types.str; default = "KAGI_API_KEY"; description = "Secret key holding the Kagi API token."; };
        };
      };
      description = ''
        Secret holding a Kagi API token (kagi.com/settings?p=api). Injected as
        KAGI_API_KEY, and delivered upstream as `Authorization: Bot <token>` — Kagi's
        own scheme word, not Bearer. The secret must exist in the broker namespace.
      '';
    };
  };

  config = lib.mkIf (bcfg.enable && scfg.enable) {
    scooter.broker.extraEnv = [
      {
        name = "KAGI_API_KEY";
        valueFrom.secretKeyRef = {
          name = scfg.apiKeySecret.name;
          key = scfg.apiKeySecret.key;
        };
      }
    ];
  };
}
