{
  contribs.brave = {
    src = ./.;
    # Broker half: proxies /brave/* with the subscription token injected, so the
    # key never reaches the sandbox.
    services.broker.enable = true;
    # Sandbox half: the in-pod MCP server exposing `brave_search`, which calls that
    # proxy. Independent of kagi's — enabling both gives the agent both tools.
    sandbox.module = ./sandbox.nix;
    deployment.module = ./deployment.nix;
    skills."scooter-brave.md" = ./skills/scooter-brave.md;
    ui.tools.brave_search = {
      argKey = "query";
      action = "searched Brave";
      titles = [ "Search the web (Brave)" ];
    };
  };
}
