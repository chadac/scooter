# mcpServers.<name>: declarative in-pod MCP servers registered with the agent.
# One option renders both the systemd unit `mcp-<name>` and the discovery
# manifest /run/scooter/mcp-servers.json the agent-host reads to learn each
# server's port. The agent-host proxies to podIP:port; the sandbox-isolation
# NetworkPolicy admits only the agent-host to their reserved port range. Unlike
# web services, units are restartIfChanged and ports are auto-assigned.

{ config, lib, pkgs, ... }:

let
  cfg = config.mcpServers;
  enabled = lib.filterAttrs (_: s: s.enable) cfg;

  unitName = name: "mcp-${name}";

  # Auto-assigned ports start here; a rebuild can hand a port to a different server, so the agent-host rebuilds its session whenever the offered set changes.
  range = import ./mcp-port-range.nix;
  basePort = range.first;
  maxAutoPorts = range.last - range.first + 1;

  # Names wanting an auto port, sorted so assignment is a pure function of the enabled set.
  autoNames = lib.sort (a: b: a < b)
    (lib.attrNames (lib.filterAttrs (_: s: s.port == null) enabled));

  # name -> resolved port: explicit if given, else basePort + its index in autoNames.
  portOf = name:
    let s = enabled.${name};
    in if s.port != null then s.port
       else basePort + (lib.lists.findFirstIndex (n: n == name) 0 autoNames);

  resolvedPorts = lib.mapAttrsToList (name: _: portOf name) enabled;

  # Read by the agent-host McpServerRegistry; holds no credential.
  manifestJSON = builtins.toJSON {
    servers = lib.mapAttrsToList (name: s: {
      inherit name;
      displayName = s.displayName;
      description = s.description;
      port = portOf name;
      path = s.path;
      unit = unitName name;
      autoStart = s.autoStart;
    }) enabled;
  };
  manifestFile = pkgs.writeText "mcp-servers.json" manifestJSON;

  stateFile = "/workspace/.scooter/mcp.json";

  scooterMcp = pkgs.writeShellApplication {
    name = "scooter-mcp";
    runtimeInputs = [ pkgs.systemd pkgs.jq pkgs.coreutils ];
    text = ''
      set -euo pipefail
      MANIFEST=/run/scooter/mcp-servers.json
      STATE=${stateFile}

      # Persisted autostart set on the workspace PVC, read by the boot restore oneshot after a resume recreates the pod.
      state_write() {  # ARGS... = jq args then the filter, LAST
        mkdir -p "$(dirname "$STATE")"
        cur='{"enabled":{}}'
        [ -s "$STATE" ] && cur=$(cat "$STATE")
        tmp=$(mktemp "$(dirname "$STATE")/.mcp.XXXXXX")
        if printf '%s' "$cur" | jq "$@" > "$tmp"; then
          mv -f "$tmp" "$STATE"
        else
          rm -f "$tmp"; return 1
        fi
      }
      state_enable() {
        now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        # shellcheck disable=SC2016  # $n/$t are jq vars (via --arg), not shell
        state_write --arg n "$1" --arg t "$now" '.enabled[$n] = {since: $t, autostart: true}'
      }
      state_disable() {
        # shellcheck disable=SC2016  # $n is a jq var (via --arg), not shell
        state_write --arg n "$1" 'del(.enabled[$n])'
      }

      usage() {
        cat >&2 <<'EOF'
      scooter-mcp — start/stop MCP servers declared in your environment.

        scooter-mcp list                 list servers + running state
        scooter-mcp status <name>        show one server's state + port
        scooter-mcp start   <name>       start it (systemctl start)
        scooter-mcp stop    <name>       stop it
        scooter-mcp restart <name>       restart it
        scooter-mcp restore              start every autostart server (boot)

      Servers are DECLARED in your environment (mcpServers.<name>); this only drives
      their systemd units, so no `scooter-rebuild` is needed to start one. The agent
      picks up a changed server set on its next message.
      EOF
      }

      have_manifest() { [ -s "$MANIFEST" ] || { echo "scooter-mcp: no MCP servers declared (manifest $MANIFEST missing)" >&2; exit 1; }; }
      unit_of() { jq -r --arg n "$1" '.servers[] | select(.name==$n) | .unit' "$MANIFEST"; }
      port_of() { jq -r --arg n "$1" '.servers[] | select(.name==$n) | .port' "$MANIFEST"; }
      resolve() {
        have_manifest
        u=$(unit_of "$1")
        [ -n "$u" ] && [ "$u" != "null" ] || { echo "scooter-mcp: unknown server '$1' (see: scooter-mcp list)" >&2; exit 2; }
        echo "$u"
      }
      state() { systemctl is-active "$1" 2>/dev/null || true; }

      cmd="''${1:-}"; name="''${2:-}"
      case "$cmd" in
        list|"")
          have_manifest
          # Build the whole table and emit it once, so a downstream reader closing the pipe early cannot SIGPIPE a mid-loop printf.
          out=$(printf '%-16s %-9s %s\n' NAME STATE PORT)
          while IFS=$'\t' read -r n u p; do
            [ -n "$n" ] || continue
            out="$out"$'\n'"$(printf '%-16s %-9s %s' "$n" "$(state "$u")" "$p")"
          done <<< "$(jq -r '.servers[] | "\(.name)\t\(.unit)\t\(.port)"' "$MANIFEST")"
          printf '%s\n' "$out" || true
          ;;
        status)
          [ -n "$name" ] || { usage; exit 2; }
          u=$(resolve "$name")
          echo "$name: $(state "$u")  unit=$u  port=$(port_of "$name")" || true
          ;;
        start|stop|restart)
          [ -n "$name" ] || { usage; exit 2; }
          u=$(resolve "$name")
          systemctl "$cmd" "$u"
          # Persist the autostart intent best-effort, so a state-write failure cannot fail the requested action.
          case "$cmd" in
            start|restart) state_enable "$name" || true ;;
            stop)          state_disable "$name" || true ;;
          esac
          echo "$name: $(state "$u")  ($cmd applied)"
          [ "$cmd" != "stop" ] && echo "port: $(port_of "$name")" || true
          ;;
        restore)
          [ -s "$STATE" ] || { echo "scooter-mcp: no persisted servers to restore"; exit 0; }
          names=$(jq -r '.enabled | to_entries[] | select(.value.autostart == true) | .key' "$STATE" 2>/dev/null || true)
          [ -n "$names" ] || { echo "scooter-mcp: no autostart servers"; exit 0; }
          rc=0
          while IFS= read -r n; do
            [ -n "$n" ] || continue
            u=$(unit_of "$n")
            if [ -z "$u" ] || [ "$u" = "null" ]; then
              echo "scooter-mcp: restore skips '$n' — not in this environment's servers" >&2
              continue
            fi
            if systemctl start "$u"; then
              echo "restored $n ($u)"
            else
              echo "scooter-mcp: restore failed to start '$n' ($u)" >&2
              rc=1
            fi
          done <<< "$names"
          exit $rc
          ;;
        -h|--help|help) usage ;;
        *) echo "scooter-mcp: unknown command '$cmd'" >&2; usage; exit 2 ;;
      esac
    '';
  };

  serverOpts = { name, ... }: {
    options = {
      enable = lib.mkEnableOption "the ${name} MCP server";

      command = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = ''
          ExecStart for a server that already speaks streamable HTTP. It must listen
          on 0.0.0.0 at `port`, which the unit also exports as `$MCP_PORT`, since the
          agent-host reaches it at the pod IP. Mutually exclusive with stdioCommand.
        '';
      };

      stdioCommand = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "\${pkgs.mcp-server-time}/bin/mcp-server-time";
        description = ''
          A stdio MCP server, the common shape. It is wrapped by `stdioWrapper` to
          serve streamable HTTP on `port`, since the agent runs outside this pod and
          cannot speak stdio to it. Mutually exclusive with command.
        '';
      };

      stdioWrapper = lib.mkOption {
        type = lib.types.functionTo lib.types.str;
        default = { port, stdioCommand }:
          "exec ${pkgs.mcp-proxy}/bin/mcp-proxy --stateless --host 0.0.0.0 --port ${toString port} -- ${stdioCommand}";
        defaultText = lib.literalExpression ''"exec ''${pkgs.mcp-proxy}/bin/mcp-proxy --stateless --host 0.0.0.0 --port <port> -- <stdioCommand>"'';
        description = ''
          How a stdio server is bridged to streamable HTTP, given `port` and
          `stdioCommand`. The default is mcp-proxy in stateless mode, so the agent
          holds no MCP session that a restart (a rebuild, or a suspend and resume)
          would invalidate.
        '';
      };

      port = lib.mkOption {
        type = lib.types.nullOr (lib.types.ints.between range.first range.last);
        default = null;
        description = ''
          In-pod TCP port, within 9700-9799: the NetworkPolicy lets only the agent-host
          reach that range. Leave null (the default) to have one assigned from 9700;
          the manifest tells the agent-host which one it got.

          Assignment is by index in the sorted set of auto-port servers, so adding a
          server whose name sorts earlier renumbers the ones after it. That is safe:
          the agent reaches each server through the agent-host by name, which reads
          the port from the manifest per request. It is also why these units are
          restartIfChanged = true, unlike webServices: a renumbered server must
          actually rebind.
        '';
      };

      path = lib.mkOption {
        type = lib.types.str;
        default = "/mcp";
        description = "HTTP path the MCP endpoint is served under.";
      };

      description = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "What this server is for. Surfaced to the agent and the UI.";
      };

      displayName = lib.mkOption {
        type = lib.types.str;
        default = name;
        description = "Human label shown in the UI.";
      };

      autoStart = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Start with the system. Unlike a web service (which a human opens on
          demand), a declared MCP server should be up whenever the agent might call
          its tools — the agent has no way to know it must start one first.
        '';
      };

      user = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Run as this user; null => DynamicUser. A server needing the workspace or a real HOME (npx/uv caches) sets a concrete user.";
      };

      workingDirectory = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "ExecStart working directory (e.g. /workspace).";
      };

      environment = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        default = { };
        description = "Extra environment for the unit.";
      };

      extraConfig = lib.mkOption {
        type = lib.types.attrsOf lib.types.anything;
        default = { };
        description = ''
          Arbitrary extra `systemd.services.mcp-<name>` settings, recursively merged
          OVER the option's own (so it can override them).
        '';
      };
    };
  };
in
{
  options.mcpServers = lib.mkOption {
    type = lib.types.attrsOf (lib.types.submodule serverOpts);
    default = { };
    description = "Declarative in-pod MCP servers, registered with the agent on its next message.";
  };

  config = lib.mkMerge [
  {
    # Always rendered, so a missing manifest means unreadable, never none declared.
    systemd.tmpfiles.rules = [
      "d /run/scooter 0755 root root -"
      "L+ /run/scooter/mcp-servers.json - - - - ${manifestFile}"
    ];
  }
  (lib.mkIf (enabled != { }) {
    environment.systemPackages = [ scooterMcp ];

    # The agent-host dials podIP:port; the NetworkPolicy admits only it to this range.
    networking.firewall.allowedTCPPorts = resolvedPorts;

    systemd.services = lib.mapAttrs' (name: s:
      let
        port = portOf name;
        # CONVERSATION_ID/URL are container env on PID 1's environ, not systemd's manager env, so recover them per unit.
        convEnvScript = pkgs.writeShellScript "mcp-${name}-conv-env" ''
          set -eu
          out="''${RUNTIME_DIRECTORY%%:*}/conv.env"
          : > "$out"
          for k in CONVERSATION_ID CONVERSATION_URL; do
            v=$(tr '\0' '\n' < /proc/1/environ | sed -n "s/^$k=//p" | head -1 || true)
            if [ -n "$v" ]; then printf '%s=%s\n' "$k" "$v" >> "$out"; fi
          done
        '';
        # A stdio server is bridged to streamable HTTP by `stdioWrapper`; an http one runs as given.
        execStart =
          if s.stdioCommand != null then
            "${pkgs.bash}/bin/bash -c ${lib.escapeShellArg (s.stdioWrapper { inherit (s) stdioCommand; inherit port; })}"
          else
            s.command;
        base = {
          description = "MCP server: ${s.displayName}";
          # A renumbered port must rebind or the manifest points at a dead port.
          restartIfChanged = true;
          wantedBy = lib.optionals s.autoStart [ "multi-user.target" ];
          path = [ "/run/current-system/sw" "/run/wrappers" ];
          serviceConfig = {
            RuntimeDirectory = unitName name;
            # `+` runs as root because /proc/1/environ is unreadable by a DynamicUser.
            ExecStartPre = "+${convEnvScript}";
            EnvironmentFile = "-/run/${unitName name}/conv.env";
            ExecStart = execStart;
            Restart = "on-failure";
          }
          // (if s.user != null then { User = s.user; } else { DynamicUser = true; })
          // (lib.optionalAttrs (s.workingDirectory != null) { WorkingDirectory = s.workingDirectory; });
          environment = s.environment // { MCP_PORT = toString port; };
        };
      in
      lib.nameValuePair (unitName name) (lib.recursiveUpdate base s.extraConfig)
    ) enabled
    // {
      # Restores servers the agent started by hand before a suspend, best-effort so one bad server cannot wedge boot.
      scooter-mcp-restore = {
        description = "restore MCP servers enabled before suspend (from ${stateFile})";
        wantedBy = [ "multi-user.target" ];
        after = [ "workspace.mount" "local-fs.target" ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          ExecStart = "${scooterMcp}/bin/scooter-mcp restore";
        };
      };
    };

    assertions = [
      {
        # Explicit ports can collide with each other or with auto-assigned ones.
        assertion = lib.length resolvedPorts == lib.length (lib.unique resolvedPorts);
        message =
          "mcpServers: enabled servers must have unique ports (resolved: "
          + lib.concatMapStringsSep ", " toString (lib.sort (a: b: a < b) resolvedPorts)
          + "). Two servers set the same explicit `port`, or an explicit port "
          + "collides with an auto-assigned one — leave `port` unset to get a free one.";
      }
      {
        assertion = lib.length autoNames <= maxAutoPorts;
        message = "mcpServers: more than ${toString maxAutoPorts} auto-port servers; assign `port` explicitly.";
      }
    ] ++ lib.mapAttrsToList (name: _: {
      # The agent sees tools as mcp__sandbox-<name>__<tool>, which model APIs restrict.
      assertion = builtins.match "[A-Za-z0-9_-]+" name != null;
      message = "mcpServers.${name}: names may use only letters, digits, '_' and '-'.";
    }) enabled
    ++ lib.mapAttrsToList (name: s: {
      assertion = (s.command == null) != (s.stdioCommand == null);
      message = "mcpServers.${name}: set exactly one of `command` or `stdioCommand`.";
    }) enabled;
  })
  ];
}
