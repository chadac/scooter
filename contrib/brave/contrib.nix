# brave DECLARED: what this contrib IS. Its deployment options are in
# ./deployment.nix — a different eval, which is why it is a different file
# (contrib/README.md).
{ lib, ... }:
let
  inherit (lib) mkOption types;
in
{
  contribs.brave = {
    options.apiKeySecret = mkOption {
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

        The key is what the provider gates its own `enabled` on, so a deployment that
        enables this contrib and forgets the secret gets a broker with no brave
        provider and an agent with no brave_web_search — never a tool that 401s.
      '';
    };

    config = {
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
    };
  };
}
