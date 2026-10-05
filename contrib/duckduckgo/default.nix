{
  contribs.duckduckgo = {
    src = ./.;
    services.broker.enable = true;

    # No `ui` and no `skills`, for the reasons in contrib/brave/default.nix. What is
    # specific to this provider — keyless, least reliable — lives in the tool's
    # docstring, which is what the agent reads when choosing between search tools.

    # The deployment half, inline — see contrib/brave/default.nix. One option and one
    # env entry, since there is no secret to point at.
    deployment.module = { config, lib, ... }:
      let
        inherit (lib) mkOption types;
        bcfg = config.agentSandbox.broker;
        scfg = bcfg.duckduckgo;
      in
      {
        options.agentSandbox.broker.duckduckgo = {
          enable = mkOption {
            type = types.bool;
            default = false;
            description = ''
              Enable the keyless DuckDuckGo search provider, which serves the agent's
              `duckduckgo_web_search` tool. Combinable with `brave` and `kagi`.

              THE ONLY SEARCH PROVIDER THAT NEEDS NO ACCOUNT, so it is the one a
              deployment can always have — and the least reliable, because it has no
              API: it reads DuckDuckGo's public no-JavaScript results page, which is
              rate-limited per source address (a shared cluster egress IP reaches that
              limit sooner than a laptop does) and can be restyled without notice. Both
              arrive as a failure the agent is told about, never as an empty web.

              Prefer `brave` where paying ~$0 for typical single-user volume is
              acceptable; enable this when it is not, or as a free second index. No
              secret to configure: the switch is this option alone, which is why it
              defaults off — nothing should start scraping a search engine without
              someone asking for it.
            '';
          };
        };

        # No secret, so the only env is the switch itself. Gated on the broker too:
        # without it there is no container to inject env into.
        config = lib.mkIf (bcfg.enable && scfg.enable) {
          agentSandbox.broker.extraEnv = [
            { name = "DUCKDUCKGO_ENABLED"; value = "true"; }
          ];
        };
      };
  };
}
