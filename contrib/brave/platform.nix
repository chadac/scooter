# brave's PLATFORM half: the options an operator sets, and the broker env they render.
#
# A plain module in the SAME eval as modules/platform.nix, which imports every
# enabled contrib's `platform.nix` from beside its declaration
# (contrib/platform-modules.nix). So the options below are declared exactly where
# any other platform option is — there is no registration step and nothing to list.
# Why: #599, #711.
#
# Don't reach for a SIBLING contrib's options bare: `bcfg.kagi.enable` resolves only in
# an image that also builds kagi, so it breaks every image shipping one without the
# other. Workarounds and when to prefer neither: contrib/README.md.
#
# `{ config, lib, ... }` only, and nothing built: an external deployer imports
# platform.nix with no `pkgs`, so a module forcing a package here is an eval error.
{ config, lib, ... }:

let
  inherit (lib) mkOption types;
  bcfg = config.scooter.broker;
  scfg = bcfg.brave;
in
{
  options.scooter.broker.brave = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Enable the Brave Search provider, which serves the agent's `brave_web_search`
        tool.

        The search provider to reach for first: $5/1k requests against $5 of credit
        granted monthly, so typical single-user volume is free. Combinable with `kagi`
        and `duckduckgo` — each names its tool for itself, so the agent gets one tool
        per enabled index and picks between them. Ships no raw /brave/* proxy route: a
        passthrough would let the agent spend the search quota on arbitrary paths.
      '';
    };
    apiKeySecret = mkOption {
      type = types.submodule {
        options = {
          name = mkOption { type = types.str; description = "Secret name (in the broker namespace)."; };
          key = mkOption { type = types.str; default = "BRAVE_SEARCH_API_KEY"; description = "Secret key holding the Brave subscription token."; };
        };
      };
      description = ''
        Secret holding a Brave Search subscription token (api-dashboard.search.brave.com).
        Injected as BRAVE_SEARCH_API_KEY; the broker delivers it upstream as an
        X-Subscription-Token HEADER, never a query param — a key in a URL is copied
        into every access log it passes. The secret must exist in the broker namespace.
      '';
    };
  };

  # Gated on the BROKER being deployed as well as brave: without the broker there is no
  # container to inject env into. The key is what the provider gates its own `enabled`
  # on, so a deployment that sets `enable` and forgets the secret gets a broker with no
  # brave provider and an agent with no brave_web_search — never a tool that 401s.
  config = lib.mkIf (bcfg.enable && scfg.enable) {
    scooter.broker.extraEnv = [
      {
        name = "BRAVE_SEARCH_API_KEY";
        valueFrom.secretKeyRef = {
          name = scfg.apiKeySecret.name;
          key = scfg.apiKeySecret.key;
        };
      }
    ];
  };
}
