# brave's DEPLOYMENT half: the options an operator sets, and the broker env they
# render. Layered into modules/platform.nix by contrib/deployment-modules.nix.
#
# `{ config, lib, ... }` only, and nothing built: an external deployer imports
# platform.nix with no `pkgs` (see contrib/deployment-modules.nix).
{ config, lib, ... }:

let
  inherit (lib) mkOption types;
  cfg = config.agentSandbox;
  bcfg = cfg.broker;
  acfg = bcfg.brave;
in
{
  options.agentSandbox.broker.brave = {
    # Also THE GATE for this contrib's skills: platform.nix ships scooter-brave.md
    # only where this is true, because an agent taught to call /brave/* on a broker
    # that never mounted those routes reads the 404 as the feature being broken.
    enable = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Enable the Brave Search provider: proxies /brave/* to api.search.brave.com
        with the subscription token injected, and ships the in-pod `brave_search`
        MCP tool.

        Brave is $5/1k requests with $5 of credit granted monthly, so typical
        single-user volume is free.
      '';
    };
    apiKeySecret = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = ''
        Name of the Secret holding the Brave Search API key under key `apiKey`.
        Wired to BRAVE_SEARCH_API_KEY on the BROKER (never the sandbox). Create it
        out-of-band, since it is a credential rather than config:
        kubectl -n <ns> create secret generic brave-search-key --from-literal=apiKey=BSA...
      '';
    };
  };

  config = lib.mkIf acfg.enable {
    agentSandbox.broker.extraEnv =
      # Assert rather than render a provider that cannot authenticate: with no Secret
      # the broker's factory sees an empty key, reports `enabled=False`, and /brave/*
      # silently never mounts — so the agent's tool 404s with nothing naming the cause.
      # An inline assert, not an `assertions` entry: kubenix's module system has no
      # such option, and a bare mkIf would make this a runtime mystery instead.
      assert lib.assertMsg (acfg.apiKeySecret != null)
        "agentSandbox.broker.brave.enable requires agentSandbox.broker.brave.apiKeySecret (the Secret holding the Brave API key under key `apiKey`).";
      [{
        name = "BRAVE_SEARCH_API_KEY";
        # optional: a not-yet-created Secret leaves the env unset, so the provider
        # reports itself disabled and /brave/* 404s — rather than wedging the WHOLE
        # broker in CreateContainerConfigError, which would take every other
        # integration down with it. Matches how the key is created out-of-band.
        valueFrom.secretKeyRef = {
          name = acfg.apiKeySecret;
          key = "apiKey";
          optional = true;
        };
      }];
  };
}
