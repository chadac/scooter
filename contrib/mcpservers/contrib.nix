# mcpservers' declaration: MCP servers listed in Settings, started in each sandbox.
{
  contribs.mcpservers = {
    src = ./.;
    sandbox.module = ./sandbox.nix;

    # Its own database, contrib_mcpservers, with migrations in ./sql.
    db = {
      enable = true;
      tables.mcp_servers = { };
    };

    services.broker = {
      enable = true;
      pythonDeps = ps: [ ps.aiosqlite ];
      env.MCPSERVERS_ENABLED = "true";
    };

    skills."scooter-mcp-servers.md" = ./skills/scooter-mcp-servers.md;

    ui.settingsTabs = [{
      id = "mcpservers";
      label = "MCP servers";
      order = 43;
      entry = "ui/SettingsTab.tsx";
      api = true;
    }];
  };
}
