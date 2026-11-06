# mcpservers' declaration: MCP servers listed in Settings, started in each sandbox.
{
  contribs.mcpservers = {
    src = ./.;
    sandbox.module = ./sandbox.nix;

    # Its own database, contrib_mcpservers, with migrations in ./sql.
    db = {
      enable = true;
      tables.mcp_servers = { };
      tables.mcp_server_status = { };
    };

    services.broker = {
      enable = true;
      pythonDeps = ps: [ ps.aiosqlite ];
      env.MCPSERVERS_ENABLED = "true";
    };

    skills."scooter-mcp-servers.md" = ./skills/scooter-mcp-servers.md;

    # The Session tab's section: this conversation's servers and their state.
    ui.panel = { label = "MCP servers"; entry = "ui/Panel.tsx"; api = true; };

    ui.settingsTabs = [{
      id = "mcpservers";
      label = "MCP servers";
      order = 43;
      entry = "ui/SettingsTab.tsx";
      api = true;
    }];
  };
}
