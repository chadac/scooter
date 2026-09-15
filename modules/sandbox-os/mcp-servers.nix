# mcpServers.<name> — declarative in-pod MCP servers registered with the agent.
#
# The option is the single source of truth for BOTH:
#   1. the systemd unit `mcp-<name>` that runs the server, AND
#   2. the discovery manifest /run/scooter/mcp-servers.json the agent-host reads
#      (via exec) to learn <name> -> port, so it can offer the server to the
#      agent's ACP session as an MCP endpoint.
#
# Shaped after web-services.nix (same manifest+unit+CLI+PVC-state pattern), with
# three deliberate differences, each of which will bite someone who "fixes" it:
#   - servers bind LOOPBACK and the firewall is NOT opened (see listenAddress);
#   - units are restartIfChanged = true (see the port option);
#   - ports are auto-assigned (see basePort).
# See issue #520.

{ config, lib, pkgs, ... }:

let
  cfg = config.mcpServers;
  enabled = lib.filterAttrs (_: s: s.enable) cfg;

  unitName = name: "mcp-${name}";

  # Auto-assigned ports start here. Clear of the built-in web services (marimo
  # 2718, ttyd 7681, code-server 8443) — the assertions below prove it rather
  # than trusting this comment.
  basePort = 9700;
  maxAutoPorts = 100;

  # Names wanting an auto port, in a stable order. Sorted so assignment is a pure
  # function of the enabled set (not attrset iteration order).
  autoNames = lib.sort (a: b: a < b)
    (lib.attrNames (lib.filterAttrs (_: s: s.port == null) enabled));

  # name -> resolved port: explicit if given, else basePort + its index in autoNames.
  portOf = name:
    let s = enabled.${name};
    in if s.port != null then s.port
       else basePort + (lib.lists.findFirstIndex (n: n == name) 0 autoNames);

  resolvedPorts = lib.mapAttrsToList (name: _: portOf name) enabled;
  webServicePorts = lib.mapAttrsToList (_: s: s.port)
    (lib.filterAttrs (_: s: s.enable) (config.webServices or { }));

  # The discovery manifest (contract with the agent-host McpServerRegistry):
  #   { "servers": [ { name, displayName, description, port, path, unit, autoStart,
  #                    listenAddress } ] }
  # No credential here: the access control is the LOOPBACK BIND, not a secret. Why
  # not a token: PR #521.
  manifestJSON = builtins.toJSON {
    servers = lib.mapAttrsToList (name: s: {
      inherit name;
      displayName = s.displayName;
      description = s.description;
      port = portOf name;
      path = s.path;
      unit = unitName name;
      autoStart = s.autoStart;
      listenAddress = s.listenAddress;
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

      # Persisted autostart set, on the WORKSPACE PVC so it survives suspend/resume:
      # the pod is recreated on resume, dropping every unit, and the boot restore
      # oneshot reads this to know what to bring back. Atomic writes (tmp + mv).
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
          # Build the whole table, then emit ONCE — a downstream `| grep -q` that closes
          # the pipe early would otherwise SIGPIPE a mid-loop printf, which under
          # `set -e -o pipefail` fails the command. Here-string, not a pipe, so the loop
          # runs in THIS shell.
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
          # Persist the autostart intent BEFORE reporting; best-effort, since a
          # state-write failure must not fail the action the caller asked for.
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
          ExecStart for a server that already speaks streamable HTTP. It MUST bind
          `listenAddress`:`port`. Mutually exclusive with stdioCommand.
        '';
      };

      stdioCommand = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = ''
          A STDIO MCP server (the common shape). Wrapped by mcp-proxy to expose
          streamable HTTP on `port`, since the agent runs outside this pod and
          cannot speak stdio to it. Mutually exclusive with command.
        '';
      };

      stdioWrapper = lib.mkOption {
        type = lib.types.functionTo lib.types.str;
        default = { listenAddress, port, stdioCommand }:
          "exec uv tool run mcp-proxy --host ${listenAddress} --port ${toString port} -- ${stdioCommand}";
        defaultText = lib.literalExpression ''uv tool run mcp-proxy --host <addr> --port <port> -- <stdioCommand>'';
        description = ''
          How a stdio server is bridged to streamable HTTP. The default runs
          mcp-proxy through `uv` (already in the sandbox stub set), so no new
          package is needed; override it to pin a different bridge. The default's
          exact flags are only exercised once the npx/uvx work lands — a server
          using `command` does not go through here at all.
        '';
      };

      port = lib.mkOption {
        type = lib.types.nullOr lib.types.port;
        default = null;
        description = ''
          In-pod TCP port. Leave null (the default) to have one assigned — the port
          is mechanism nobody declaring a server should have to pick, and the
          manifest tells the agent-host which one it got.

          Auto-assignment is by index in the sorted set of auto-port servers, so
          adding a server whose name sorts earlier RENUMBERS the ones after it.
          That is harmless by construction: the unit and the manifest come from one
          evaluation and cannot disagree, and the agent-host re-reads the manifest.
          It is also why these units are restartIfChanged = true (unlike
          webServices): a renumbered server must actually rebind, or the manifest
          advertises a port nothing is listening on.
        '';
      };

      listenAddress = lib.mkOption {
        type = lib.types.str;
        default = "127.0.0.1";
        description = ''
          Bind address. Defaults to LOOPBACK, and the firewall is left closed, so a
          declared server is not reachable from other pods. An MCP server exposes
          real capability (the workspace, brokered credentials) and these pods have
          no NetworkPolicy, so binding 0.0.0.0 would publish that to every pod that
          can route here. Set to "0.0.0.0" only together with an ingress control.
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

  config = lib.mkIf (enabled != { }) {
    environment.systemPackages = [ scooterMcp ];

    # Only open the firewall for servers deliberately bound off-loopback. A
    # loopback-bound server needs no rule, and opening one for it would be a lie.
    networking.firewall.allowedTCPPorts =
      lib.mapAttrsToList (name: _: portOf name)
        (lib.filterAttrs (_: s: s.listenAddress != "127.0.0.1") enabled);

    systemd.services = lib.mapAttrs' (name: s:
      let
        port = portOf name;
        # CONVERSATION_ID/URL reach the pod as CONTAINER env — on PID 1's environ but
        # NOT in systemd's manager env, so a unit never sees them. Same recovery the
        # web services do; an MCP server often wants to know its conversation.
        convEnvScript = pkgs.writeShellScript "mcp-${name}-conv-env" ''
          set -eu
          out="''${RUNTIME_DIRECTORY%%:*}/conv.env"
          : > "$out"
          for k in CONVERSATION_ID CONVERSATION_URL; do
            v=$(tr '\0' '\n' < /proc/1/environ | sed -n "s/^$k=//p" | head -1 || true)
            if [ -n "$v" ]; then printf '%s=%s\n' "$k" "$v" >> "$out"; fi
          done
        '';
        # A stdio server is bridged to streamable HTTP by `stdioWrapper`; an http one
        # runs as given.
        execStart =
          if s.stdioCommand != null then
            "${pkgs.bash}/bin/bash -c ${lib.escapeShellArg (s.stdioWrapper { inherit (s) listenAddress stdioCommand; inherit port; })}"
          else
            s.command;
        base = {
          description = "MCP server: ${s.displayName}";
          # TRUE, unlike webServices: a renumbered port must rebind or the manifest
          # points at a dead port. Why this differs: PR #521.
          restartIfChanged = true;
          wantedBy = lib.optionals s.autoStart [ "multi-user.target" ];
          path = [ "/run/current-system/sw" "/run/wrappers" ];
          serviceConfig = {
            RuntimeDirectory = unitName name;
            # `+` = run as root: /proc/1/environ is 0400 root, unreadable by a DynamicUser.
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
      # Restore the servers that were running before the pod was recreated
      # (suspend/resume). autoStart servers come up via wantedBy; this covers ones
      # the agent started by hand. Best-effort so one bad server cannot wedge boot.
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

    systemd.tmpfiles.rules = [
      "d /run/scooter 0755 root root -"
      "L+ /run/scooter/mcp-servers.json - - - - ${manifestFile}"
    ];

    assertions = [
      {
        # The one the review asked for: two EXPLICIT ports can collide with each
        # other, which the auto-vs-explicit check below would never see.
        assertion = lib.length resolvedPorts == lib.length (lib.unique resolvedPorts);
        message =
          "mcpServers: enabled servers must have unique ports (resolved: "
          + lib.concatMapStringsSep ", " toString (lib.sort (a: b: a < b) resolvedPorts)
          + "). Two servers set the same explicit `port`, or an explicit port "
          + "collides with an auto-assigned one — leave `port` unset to get a free one.";
      }
      {
        assertion = lib.intersectLists resolvedPorts webServicePorts == [ ];
        message =
          "mcpServers: port(s) "
          + lib.concatMapStringsSep ", " toString (lib.intersectLists resolvedPorts webServicePorts)
          + " collide with webServices. Both share the pod's port space.";
      }
      {
        assertion = lib.length autoNames <= maxAutoPorts;
        message = "mcpServers: more than ${toString maxAutoPorts} auto-port servers; assign `port` explicitly.";
      }
    ] ++ lib.mapAttrsToList (name: s: {
      assertion = (s.command == null) != (s.stdioCommand == null);
      message = "mcpServers.${name}: set exactly one of `command` or `stdioCommand`.";
    }) enabled;
  };
}
