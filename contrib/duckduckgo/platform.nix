# duckduckgo's PLATFORM half. A module in the same eval as modules/platform.nix,
# imported by convention from contrib/platform-modules.nix. See
# contrib/brave/platform.nix for the pattern and the one rule.
{ config, lib, ... }:

let
  inherit (lib) mkOption types;
  bcfg = config.scooter.broker;
  scfg = bcfg.duckduckgo;
in
{
  options.scooter.broker.duckduckgo = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Enable the keyless DuckDuckGo search provider, which serves the agent's
        `duckduckgo_web_search` tool. Combinable with `brave` and `kagi`.

        THE ONLY SEARCH PROVIDER THAT NEEDS NO ACCOUNT, so it is the one a deployment
        can always have — and the least reliable, because it has no API: it reads
        DuckDuckGo's public no-JavaScript results page, which is rate-limited per source
        address (a shared cluster egress IP reaches that limit sooner than a laptop
        does) and can be restyled without notice. Both arrive as a failure the agent is
        told about, never as an empty web.

        Prefer `brave` where paying ~$0 for typical single-user volume is acceptable;
        enable this when it is not, or as a free second index. No secret to configure:
        the switch is this option alone, which is why it defaults off — nothing should
        start scraping a search engine without someone asking for it.
      '';
    };
  };

  # No secret, so the only env is the switch itself. Gated on the broker too: without it
  # there is no container to inject env into.
  config = lib.mkIf (bcfg.enable && scfg.enable) {
    scooter.broker.extraEnv = [
      { name = "DUCKDUCKGO_ENABLED"; value = "true"; }
    ];
  };
}
