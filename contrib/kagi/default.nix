{
  contribs.kagi = {
    src = ./.;
    # Broker half: proxies /kagi/* with the API token injected, so the key never
    # reaches the sandbox.
    services.broker.enable = true;
    # Sandbox half: the in-pod MCP server exposing `kagi_search`, which calls that
    # proxy. Independent of brave's — enabling both gives the agent both tools.
    sandbox.module = ./sandbox.nix;
    deployment.module = ./deployment.nix;
    skills."scooter-kagi.md" = ./skills/scooter-kagi.md;
    ui.tools.kagi_search = {
      argKey = "query";
      action = "searched Kagi";
      titles = [ "Search the web (Kagi)" ];
    };
  };
}
