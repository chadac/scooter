{
  contribs.brave = {
    src = ./.;
    services.broker.enable = true;

    # No `ui`: `brave_web_search` renders as a plain tool call, not a provider card —
    # the UI deliberately returns null for it (ui/src/toolCallView.test.ts), and brave
    # is not a linked-resource source, so it contributes no chip or icon either.
    #
    # No `skills` either, and that is a judgement rather than an omission: what the
    # agent needs to know about searching is the same whichever providers are wired, so
    # it stays one bullet in skills/agent-tools.md — including the rule for when
    # SEVERAL search tools are listed, which no single contrib could state. What is
    # specific to brave (an independent crawl) belongs in the tool's own docstring,
    # which is what the agent reads when choosing between two of them.

    # The deployment half, INLINE: two options and one env entry is not worth a second
    # file. A path still suits a long one — contrib/aws keeps its own deployment.nix at
    # ~200 lines. Gets `{ config, lib, ... }` from the PLATFORM eval (not this one) and
    # nothing built: contrib/deployment-modules.nix is lib-only. Why: #599, PR #707.
    deployment.module = { config, lib, ... }:
      let
        inherit (lib) mkOption types;
        bcfg = config.agentSandbox.broker;
        scfg = bcfg.brave;
      in
      {
        options.agentSandbox.broker.brave = {
          enable = mkOption {
            type = types.bool;
            default = false;
            description = ''
              Enable the Brave Search provider, which serves the agent's
              `brave_web_search` tool.

              The search provider to reach for first: $5/1k requests against $5 of
              credit granted monthly, so typical single-user volume is free. Combinable
              with `kagi` and `duckduckgo` — each names its tool for itself, so the
              agent gets one tool per enabled index and picks between them. Ships no raw
              /brave/* proxy route: a passthrough would let the agent spend the search
              quota on arbitrary paths.
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
              Secret holding a Brave Search subscription token
              (api-dashboard.search.brave.com). Injected as BRAVE_SEARCH_API_KEY; the
              broker delivers it upstream as an X-Subscription-Token HEADER, never a
              query param — a key in a URL is copied into every access log it passes.
              The secret must exist in the broker namespace.
            '';
          };
        };

        # Gated on the BROKER being deployed as well as brave: without the broker there
        # is no container to inject env into. The key is what the provider gates its own
        # `enabled` on, so a deployment that sets `enable` and forgets the secret gets no
        # brave provider and no brave_web_search — never a tool that 401s.
        config = lib.mkIf (bcfg.enable && scfg.enable) {
          agentSandbox.broker.extraEnv = [
            {
              name = "BRAVE_SEARCH_API_KEY";
              valueFrom.secretKeyRef = {
                name = scfg.apiKeySecret.name;
                key = scfg.apiKeySecret.key;
              };
            }
          ];
        };
      };
  };
}
