# webServices.<name> — declarative in-pod web services the platform
# reverse-proxies at https://<host>/c/<id>/<name>/ (marimo, web VS Code, xterm…).
#
# The option is the single source of truth for BOTH:
#   1. the systemd unit `webservice-<name>` that runs the service, AND
#   2. the discovery manifest /run/scooter/web-services.json the agent-host reads
#      (via exec) to learn <name> -> in-pod port, so the proxy knows where to
#      forward and the UI can list/start services.
#
# Explicit-start model: units are NOT wantedBy multi-user.target — the agent or the
# user (UI Start button -> agent-host -> `systemctl start webservice-<name>` via
# exec) starts them on demand. The proxy only routes. See docs/WEB_SERVICES_PROXY.md.

{ config, lib, pkgs, ... }:

let
  cfg = config.webServices;
  enabled = lib.filterAttrs (_: s: s.enable) cfg;

  unitName = name: "webservice-${name}";

  # The discovery manifest (contract with the agent-host WebServiceRegistry):
  #   { "services": [ { name, displayName, port, basePath, unit, stripBasePath }, ... ] }
  manifestJSON = builtins.toJSON {
    services = lib.mapAttrsToList (name: s: {
      inherit name;
      displayName = s.displayName;
      port = s.port;
      basePath = s.basePath;
      unit = unitName name;
      stripBasePath = s.stripBasePath;
    }) enabled;
  };
  manifestFile = pkgs.writeText "web-services.json" manifestJSON;

  # scooter-service — start/stop/restart/status a declared web service WITHOUT a
  # scooter-rebuild (the services are already declared; this just drives their
  # systemd units). Reads the discovery manifest for name→unit + basePath, so a
  # human or the agent can `scooter-service start marimo`. The units are
  # explicit-start (not wantedBy multi-user.target), so this IS how they come up.
  # Where the enabled/autostart set is persisted. On the WORKSPACE PVC (via the
  # /workspace mount), so it survives suspend/resume — the pod is recreated on
  # resume, dropping every explicit-start unit, and this file is how the boot
  # restore oneshot knows what to bring back. Contract:
  #   { "enabled": { "<name>": { "since": "<iso8601>", "autostart": true } } }
  stateFile = "/workspace/.scooter/services.json";

  scooterService = pkgs.writeShellApplication {
    name = "scooter-service";
    runtimeInputs = [ pkgs.systemd pkgs.jq pkgs.coreutils ];
    text = ''
      set -euo pipefail
      MANIFEST=/run/scooter/web-services.json
      STATE=${stateFile}

      # --- persisted enabled-set (survives suspend/resume via the workspace PVC) ---
      # Record/forget a service's autostart intent. Writes are atomic (tmp + mv) so a
      # crash mid-write can't corrupt the file the boot oneshot reads.
      state_write() {  # ARGS... = jq args (e.g. --arg n foo) then the filter, LAST
        mkdir -p "$(dirname "$STATE")"
        cur='{"enabled":{}}'
        [ -s "$STATE" ] && cur=$(cat "$STATE")
        tmp=$(mktemp "$(dirname "$STATE")/.services.XXXXXX")
        # All args flow straight through to jq (so --arg pairs + the trailing filter
        # reach it intact). On jq failure DON'T clobber the state file — remove the
        # empty tmp and return non-zero (the caller's `|| true` keeps the CLI happy,
        # but we never leave an empty services.json the restore oneshot would choke on).
        if printf '%s' "$cur" | jq "$@" > "$tmp"; then
          mv -f "$tmp" "$STATE"
        else
          rm -f "$tmp"; return 1
        fi
      }
      state_enable() {  # $1=name — mark autostart, stamp when
        now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        # shellcheck disable=SC2016  # $n/$t are jq vars (via --arg), not shell
        state_write --arg n "$1" --arg t "$now" \
          '.enabled[$n] = {since: $t, autostart: true}'
      }
      state_disable() {  # $1=name — drop it so a reboot won't restore it
        # shellcheck disable=SC2016  # $n is a jq var (via --arg), not shell
        state_write --arg n "$1" 'del(.enabled[$n])'
      }

      usage() {
        cat >&2 <<'EOF'
      scooter-service — start/stop declared web services (no rebuild needed).

        scooter-service list                 list services + running state
        scooter-service status <name>        show one service's state + URL
        scooter-service start   <name>       start it (systemctl start)
        scooter-service stop    <name>       stop it
        scooter-service restart <name>       restart it
        scooter-service restore              start every autostart service (boot)

      Services are DECLARED in your environment (webServices.<name>); this only
      drives their systemd units, so no `scooter-rebuild` is needed to start one.
      EOF
      }

      have_manifest() { [ -s "$MANIFEST" ] || { echo "scooter-service: no web services declared (manifest $MANIFEST missing)" >&2; exit 1; }; }
      unit_of() { jq -r --arg n "$1" '.services[] | select(.name==$n) | .unit' "$MANIFEST"; }
      base_of() { jq -r --arg n "$1" '.services[] | select(.name==$n) | .basePath' "$MANIFEST"; }
      resolve() {
        have_manifest
        u=$(unit_of "$1")
        [ -n "$u" ] && [ "$u" != "null" ] || { echo "scooter-service: unknown service '$1' (see: scooter-service list)" >&2; exit 2; }
        echo "$u"
      }
      state() { systemctl is-active "$1" 2>/dev/null || true; }

      cmd="''${1:-}"; name="''${2:-}"
      case "$cmd" in
        list|"")
          have_manifest
          # Build the whole table first, then emit ONCE — so a downstream `| grep -q`
          # that closes the pipe early doesn't SIGPIPE a mid-loop printf (which, under
          # `set -e -o pipefail`, would fail the command). read from a here-string, not
          # a pipe, so the loop runs in THIS shell (no subshell).
          out=$(printf '%-16s %-9s %s\n' NAME STATE URL)
          while IFS=$'\t' read -r n u b; do
            [ -n "$n" ] || continue
            out="$out"$'\n'"$(printf '%-16s %-9s %s' "$n" "$(state "$u")" "$b")"
          done <<< "$(jq -r '.services[] | "\(.name)\t\(.unit)\t\(.basePath)"' "$MANIFEST")"
          # A downstream `| grep -q` may close the pipe before we finish writing →
          # SIGPIPE (exit 141), which set -e would treat as failure. Tolerate it: the
          # output is complete-or-consumed either way.
          printf '%s\n' "$out" || true
          ;;
        status)
          [ -n "$name" ] || { usage; exit 2; }
          u=$(resolve "$name")
          echo "$name: $(state "$u")  unit=$u  url=$(base_of "$name")" || true  # tolerate `| grep -q` closing early
          ;;
        start|stop|restart)
          [ -n "$name" ] || { usage; exit 2; }
          u=$(resolve "$name")
          systemctl "$cmd" "$u"
          # Persist the autostart intent BEFORE reporting, so the state file is the
          # source of truth the boot restore oneshot reads on the next pod recreate.
          # start/restart => remember (autostart); stop => forget. Best-effort: a
          # state-write failure must not fail the systemctl action the user asked for.
          case "$cmd" in
            start|restart) state_enable "$name" || true ;;
            stop)          state_disable "$name" || true ;;
          esac
          echo "$name: $(state "$u")  ($cmd applied)"
          [ "$cmd" != "stop" ] && echo "url: $(base_of "$name")" || true
          ;;
        restore)
          # Boot path: bring back every service the user/agent had running before the
          # pod was recreated (suspend/resume). Reads the autostart set from the PVC
          # state file and starts each unit that still exists in this generation's
          # manifest (a service removed from the config is silently skipped). Tolerant:
          # one service failing to start must not fail the whole restore (best-effort,
          # like a fresh boot's wantedBy). No state => nothing to do (clean first boot).
          [ -s "$STATE" ] || { echo "scooter-service: no persisted services to restore"; exit 0; }
          names=$(jq -r '.enabled | to_entries[] | select(.value.autostart == true) | .key' "$STATE" 2>/dev/null || true)
          [ -n "$names" ] || { echo "scooter-service: no autostart services"; exit 0; }
          rc=0
          while IFS= read -r n; do
            [ -n "$n" ] || continue
            u=$(unit_of "$n")
            if [ -z "$u" ] || [ "$u" = "null" ]; then
              echo "scooter-service: restore skips '$n' — not in this environment's services" >&2
              continue
            fi
            if systemctl start "$u"; then
              echo "restored $n ($u)"
            else
              echo "scooter-service: restore failed to start '$n' ($u)" >&2
              rc=1
            fi
          done <<< "$names"
          exit $rc
          ;;
        -h|--help|help) usage ;;
        *) echo "scooter-service: unknown command '$cmd'" >&2; usage; exit 2 ;;
      esac
    '';
  };

  serviceOpts = { name, ... }: {
    options = {
      enable = lib.mkEnableOption "the ${name} web service";

      port = lib.mkOption {
        type = lib.types.port;
        description = ''
          In-pod TCP port the service listens on (bound to 0.0.0.0 so the
          agent-host can reach it at podIP:port). Must be unique across enabled
          services.
        '';
      };

      command = lib.mkOption {
        type = lib.types.str;
        description = ''
          ExecStart command line. For built-ins this points at a LAZY-TOOL stub on
          PATH (e.g. `marimo`), so the closure builds on first start and the base
          image stays small. The command MUST make the service serve under its
          basePath (e.g. marimo `--base-url ${"$"}{basePath} --proxy <host>`).
        '';
      };

      displayName = lib.mkOption {
        type = lib.types.str;
        default = name;
        description = "Human label shown in the UI Services panel.";
      };

      basePath = lib.mkOption {
        type = lib.types.str;
        default = "/c/\${CONVERSATION_ID}/${name}";
        description = ''
          The external sub-path this service is served under. The conversation id
          comes from the CONVERSATION_ID env var the provisioner injects at pod
          creation (alongside CONVERSATION_URL) — the unit's ExecStart expands it
          at start time, so no proxy-side templating is needed. The service must be
          configured to emit links/assets under this prefix (e.g. marimo
          `--base-url ${"$"}{basePath}`).
        '';
      };

      stripBasePath = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Whether the reverse proxy STRIPS the `/c/<id>/<name>` prefix before
          forwarding to the pod, so the service serves at ROOT. Set true for a
          service that CAN'T be told its base path (e.g. code-server has no
          --server-base-path). Leave false for services that handle the prefix
          themselves (marimo --base-url, ttyd --base-path) — stripping would then
          double-strip and break their asset URLs.
        '';
      };

      user = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Run as this user; null => DynamicUser. Services needing a real HOME + the workspace set a concrete user.";
      };

      workingDirectory = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "ExecStart working directory (e.g. the workspace PVC mount).";
      };

      environment = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        default = { };
        description = "Extra environment for the unit.";
      };

      extraConfig = lib.mkOption {
        type = lib.types.attrsOf lib.types.anything;
        default = { };
        example = lib.literalExpression ''
          {
            after = [ "network-online.target" ];
            serviceConfig.LimitNOFILE = 65536;
            serviceConfig.ReadWritePaths = [ "/workspace" ];
          }
        '';
        description = ''
          Arbitrary extra `systemd.services.webservice-<name>` settings, recursively
          merged OVER the option's own (so it can override them). The full
          systemd-unit vocabulary is available (after/wants, serviceConfig
          hardening, restart policy, …) — an escape hatch so the option needn't
          enumerate every knob; a built-in or the agent's module attaches
          service-specific tuning here.
        '';
      };
    };
  };
in
{
  imports = [
    ./web-services/marimo.nix
    ./web-services/vscode.nix
    ./web-services/terminal.nix
  ];

  options.webServices = lib.mkOption {
    type = lib.types.attrsOf (lib.types.submodule serviceOpts);
    default = { };
    description = "Declarative in-pod web services, reverse-proxied at /c/<id>/<name>/.";
  };

  config = lib.mkIf (enabled != { }) {
    # `scooter-service start|stop|... <name>` on PATH — start/stop declared services
    # without a rebuild (a human via the sandbox shell, or the agent via its shell tool).
    environment.systemPackages = [ scooterService ];

    # Open each enabled web service's port in the NixOS firewall. The image ships
    # with the default firewall ON (networking.firewall.enable = true), whose
    # nixos-fw chain DROPs all inbound TCP except loopback/established — so the
    # agent-host's reverse proxy (podIP:port, pod-to-pod) hung/timed out even though
    # the service answered on localhost inside the pod. Web services are declared
    # specifically to be reachable by the proxy, so open exactly their ports (and
    # nothing else — the firewall still guards every other port). See the bug report
    # web-service-proxy-blocked-by-firewall.
    networking.firewall.allowedTCPPorts = lib.mapAttrsToList (_: s: s.port) enabled;

    # One systemd unit per enabled service. NOT wantedBy multi-user.target —
    # explicit start. restartIfChanged=false so a live switch-to-configuration
    # (scooter-apply-module) doesn't bounce a running service. The per-service
    # extraConfig is recursively merged OVER the base (so it can override).
    systemd.services = lib.mapAttrs' (name: s:
      let
        # CONVERSATION_ID (+ CONVERSATION_URL) reach the pod as CONTAINER env, which
        # is on PID 1's environ but NOT in systemd's manager env — so a unit's
        # `environment`/ExecStart never sees it, and the base path collapses to
        # `/c//${name}` (double slash → 404). Same problem carry-over.nix solves for
        # BROKER_URL. Fix once for every web service: an ExecStartPre reads them from
        # /proc/1/environ into the unit's RuntimeDirectory env file, and EnvironmentFile
        # sources it before ExecStart. `-` = optional (empty is harmless; the service's
        # own `:-unknown` fallback still applies if truly unset).
        convEnvScript = pkgs.writeShellScript "webservice-${name}-conv-env" ''
          set -eu
          out="''${RUNTIME_DIRECTORY%%:*}/conv.env"
          : > "$out"
          for k in CONVERSATION_ID CONVERSATION_URL; do
            v=$(tr '\0' '\n' < /proc/1/environ | sed -n "s/^$k=//p" | head -1 || true)
            # `if` (not `[ ] && …`): an absent var (empty $v) is normal, not a failure —
            # with `set -e`, a bare `[ -n "$v" ] && …` would abort the script (exit 1)
            # whenever the var is unset, killing the service start.
            if [ -n "$v" ]; then printf '%s=%s\n' "$k" "$v" >> "$out"; fi
          done
        '';
        base = {
          description = "web service: ${s.displayName}";
          restartIfChanged = false;
          # PATH must include the system profile so the service can exec LAZY-TOOL stubs
          # (marimo / code-server live at /run/current-system/sw/bin, built on first use).
          # A systemd unit does NOT inherit a login PATH — it gets systemd's minimal
          # default — so without this `exec marimo` fails with "not found" (status 127).
          # Prepend the system profile + wrappers ahead of that default.
          path = [ "/run/current-system/sw" "/run/wrappers" ];
          serviceConfig = {
            # Materialize CONVERSATION_ID/URL from PID 1's environ, then source it.
            # The `+` prefix runs ExecStartPre as ROOT (full privileges), because
            # /proc/1/environ is root-only (0400) — a DynamicUser couldn't read it.
            # RuntimeDirectory is created before ExecStartPre and (with DynamicUser)
            # is writable by the service user, so the root pre-step can write into it.
            RuntimeDirectory = unitName name;
            ExecStartPre = "+${convEnvScript}";
            EnvironmentFile = "-/run/${unitName name}/conv.env";
            ExecStart = s.command;
            Restart = "on-failure";
          }
          // (if s.user != null then { User = s.user; } else { DynamicUser = true; })
          // (lib.optionalAttrs (s.workingDirectory != null) { WorkingDirectory = s.workingDirectory; });
          environment = s.environment;
        };
      in
      lib.nameValuePair (unitName name) (lib.recursiveUpdate base s.extraConfig)
    ) enabled
    # Boot restore: re-start every service the user had running before the pod was
    # recreated (suspend/resume drops all explicit-start units). Reads the autostart
    # set from the workspace-PVC state file and starts each unit. wantedBy
    # multi-user.target so it runs on every boot; RemainAfterExit so its "success"
    # is observable. After the web-service units are DEFINED (they're pulled in by
    # the `systemctl start` it issues, not by an ordering dep). Best-effort: it exits
    # 0 even if a service fails, so a single bad service can't wedge the boot.
    // {
      scooter-service-restore = {
        description = "restore web services enabled before suspend (from ${stateFile})";
        wantedBy = [ "multi-user.target" ];
        after = [ "workspace.mount" "local-fs.target" ];
        # The state file lives on the workspace PVC; if the mount is a real unit,
        # wait for it. Harmless when /workspace is just a dir (no such unit).
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          ExecStart = "${scooterService}/bin/scooter-service restore";
        };
      };
    };

    # Render the discovery manifest at boot (tmpfiles → /run, so it's present
    # before the agent-host reads it and survives nothing across restarts, which
    # is fine — it's static config re-created each boot).
    systemd.tmpfiles.rules = [
      "d /run/scooter 0755 root root -"
      "L+ /run/scooter/web-services.json - - - - ${manifestFile}"
    ];

    assertions = [{
      assertion =
        let ports = lib.mapAttrsToList (_: s: s.port) enabled;
        in lib.length ports == lib.length (lib.unique ports);
      message = "webServices: enabled services must have unique ports.";
    }];
  };
}
