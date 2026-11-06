# mcpservers' sandbox half: starts the owner's MCP servers from Settings as
# mcp-user@<name> units and lists them in the runtime MCP manifest
# (modules/sandbox-os/mcp-servers.nix), which the agent-host merges in.
{ config, lib, pkgs, ... }:

let
  cfg = config.programs.scooterMcpServers;
  range = import ../../modules/sandbox-os/mcp-port-range.nix;
  # The top 20 ports of the MCP range.
  ports = { first = range.last - 19; last = range.last; };

  # A stub shim keeps Node out of the image.
  node = pkgs.scooter-node or pkgs.nodejs;

  scooterMcpServers = pkgs.writeShellApplication {
    name = "scooter-mcp-servers";
    runtimeInputs = with pkgs; [ coreutils jq systemd node uv ];
    text = ''
      PORT_FIRST=${toString ports.first}
      PORT_LAST=${toString ports.last}
      MCP_PROXY=${pkgs.mcp-proxy}/bin/mcp-proxy
    '' + builtins.readFile ./scooter-mcp-servers.sh;
  };
in
{
  options.programs.scooterMcpServers.syncInterval = lib.mkOption {
    type = lib.types.str;
    default = "2min";
    description = ''
      How often the sandbox re-reads the owner's MCP servers from Settings, as a
      systemd time span. A change made in Settings reaches a running sandbox within
      this interval; `scooter-mcp-servers sync` applies it at once.
    '';
  };

  config = {
    environment.systemPackages = [ scooterMcpServers ];

    # The NetworkPolicy admits only the agent-host here.
    networking.firewall.allowedTCPPortRanges = [{ from = ports.first; to = ports.last; }];

    systemd.services."mcp-user@" = {
      description = "MCP server from Settings: %i";
      path = [ "/run/current-system/sw" "/run/wrappers" ];
      # Runs like the agent, with /workspace and root's caches.
      serviceConfig = {
        ExecStart = "${scooterMcpServers}/bin/scooter-mcp-servers run %i";
        WorkingDirectory = "/workspace";
        Environment = [ "HOME=/root" ];
        Restart = "on-failure";
        RestartSec = 10;
      };
    };

    systemd.services.scooter-mcp-servers-sync = {
      description = "Start the MCP servers listed in Settings";
      # agent-broker is on the system profile.
      path = [ "/run/current-system/sw" ];
      after = [ "network.target" "workspace.mount" ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${scooterMcpServers}/bin/scooter-mcp-servers sync";
        # The broker can be unreachable at boot.
        Restart = "on-failure";
        RestartSec = 15;
      };
    };

    systemd.timers.scooter-mcp-servers-sync = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = cfg.syncInterval;
        OnUnitInactiveSec = cfg.syncInterval;
        Unit = "scooter-mcp-servers-sync.service";
      };
    };
  };
}
