# webServices.<name>: declarative in-pod web services the platform
# reverse-proxies at https://<host>/c/<id>/<name>/.
#
# Each entry produces both the systemd unit `webservice-<name>` and an entry in
# the discovery manifest /run/scooter/web-services.json the agent-host reads to
# learn the in-pod port. Units are explicit-start, not wantedBy
# multi-user.target; the agent or the UI starts them on demand. See
# docs/WEB_SERVICES_PROXY.md.

{ config, lib, pkgs, ... }:

let
  cfg = config.webServices;
  enabled = lib.filterAttrs (_: s: s.enable) cfg;

  unitName = name: "webservice-${name}";

  # The discovery manifest the agent-host WebServiceRegistry reads.
  manifestJSON = builtins.toJSON {
    services = lib.mapAttrsToList (name: s: {
      inherit name;
      displayName = s.displayName;
      port = s.port;
      basePath = s.basePath;
      unit = unitName name;
      stripBasePath = s.stripBasePath;
    } // lib.optionalAttrs (s.resources != null) {
      # Only the declared dimensions are emitted.
      resources = lib.filterAttrs (_: v: v != null) {
        inherit (s.resources) cpu memory gpu;
      };
    }) enabled;
  };
  manifestFile = pkgs.writeText "web-services.json" manifestJSON;

  # The autostart set, on the workspace PVC so it survives suspend/resume.
  stateFile = "/workspace/.scooter/services.json";

  scooterService = pkgs.writeShellApplication {
    name = "scooter-service";
    runtimeInputs = [ pkgs.systemd pkgs.jq pkgs.coreutils ];
    text = ''
      set -euo pipefail
      MANIFEST=/run/scooter/web-services.json
      STATE=${stateFile}

      # --- persisted enabled-set ---
      # Writes are atomic so a crash mid-write cannot corrupt the state file.
      state_write() {  # args are jq args, filter last
        mkdir -p "$(dirname "$STATE")"
        cur='{"enabled":{}}'
        [ -s "$STATE" ] && cur=$(cat "$STATE")
        tmp=$(mktemp "$(dirname "$STATE")/.services.XXXXXX")
        # On jq failure keep the existing state file rather than an empty one.
        if printf '%s' "$cur" | jq "$@" > "$tmp"; then
          mv -f "$tmp" "$STATE"
        else
          rm -f "$tmp"; return 1
        fi
      }
      state_enable() {  # $1=name
        now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        # shellcheck disable=SC2016  # $n/$t are jq vars (via --arg), not shell
        state_write --arg n "$1" --arg t "$now" \
          '.enabled[$n] = {since: $t, autostart: true}'
      }
      state_disable() {  # $1=name
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
          # Emit the table once so an early-closing reader cannot SIGPIPE a
          # mid-loop printf.
          out=$(printf '%-16s %-9s %s\n' NAME STATE URL)
          while IFS=$'\t' read -r n u b; do
            [ -n "$n" ] || continue
            out="$out"$'\n'"$(printf '%-16s %-9s %s' "$n" "$(state "$u")" "$b")"
          done <<< "$(jq -r '.services[] | "\(.name)\t\(.unit)\t\(.basePath)"' "$MANIFEST")"
          # Tolerate a reader closing the pipe early.
          printf '%s\n' "$out" || true
          ;;
        status)
          [ -n "$name" ] || { usage; exit 2; }
          u=$(resolve "$name")
          echo "$name: $(state "$u")  unit=$u  url=$(base_of "$name")" || true  # tolerate an early-closing reader
          ;;
        start|stop|restart)
          [ -n "$name" ] || { usage; exit 2; }
          u=$(resolve "$name")
          systemctl "$cmd" "$u"
          # Best-effort: a state-write failure must not fail the systemctl action.
          case "$cmd" in
            start|restart) state_enable "$name" || true ;;
            stop)          state_disable "$name" || true ;;
          esac
          echo "$name: $(state "$u")  ($cmd applied)"
          [ "$cmd" != "stop" ] && echo "url: $(base_of "$name")" || true
          ;;
        restore)
          # Starts every autostart service that still exists in this manifest,
          # continuing past individual failures.
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

      resources = lib.mkOption {
        type = lib.types.nullOr (lib.types.submodule {
          options = {
            cpu = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              example = "2";
              description = "CPU this service wants, as a k8s quantity (\"2\", \"500m\").";
            };
            memory = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              example = "8Gi";
              description = "Memory this service wants, as a k8s quantity (\"8Gi\", \"512Mi\").";
            };
            gpu = lib.mkOption {
              type = lib.types.nullOr lib.types.ints.unsigned;
              default = null;
              description = "Whole GPUs this service wants.";
            };
          };
        });
        default = null;
        example = lib.literalExpression ''{ cpu = "2"; memory = "8Gi"; }'';
        description = ''
          What this service NEEDS to run comfortably. Advisory only — it never sizes
          the pod and never blocks a start. The agent-host compares it against the
          sandbox's actual allotment and, when the service wants more, hands the agent
          (and the UI) a concrete "marimo wants 8Gi, this sandbox is 4Gi" note instead
          of letting it discover the gap as an OOM kill with no explanation.

          It is an ESTIMATE written by whoever declared the service, so it must stay
          advisory: blocking on it would refuse services that would have run fine.
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
    ./web-services/terminal.nix
  ];

  options.webServices = lib.mkOption {
    type = lib.types.attrsOf (lib.types.submodule serviceOpts);
    default = { };
    description = "Declarative in-pod web services, reverse-proxied at /c/<id>/<name>/.";
  };

  config = lib.mkIf (enabled != { }) {
    # Drives the declared services' units without a rebuild.
    environment.systemPackages = [ scooterService ];

    # The firewall drops inbound TCP by default, so open exactly the service ports
    # the proxy reaches pod-to-pod.
    networking.firewall.allowedTCPPorts = lib.mapAttrsToList (_: s: s.port) enabled;

    # One explicit-start unit per enabled service, with extraConfig merged over
    # the base.
    systemd.services = lib.mapAttrs' (name: s:
      let
        # CONVERSATION_ID/URL are container env on PID 1 only, so an ExecStartPre
        # copies them from /proc/1/environ into an env file the unit sources.
        convEnvScript = pkgs.writeShellScript "webservice-${name}-conv-env" ''
          set -eu
          out="''${RUNTIME_DIRECTORY%%:*}/conv.env"
          : > "$out"
          for k in CONVERSATION_ID CONVERSATION_URL; do
            v=$(tr '\0' '\n' < /proc/1/environ | sed -n "s/^$k=//p" | head -1 || true)
            # An absent var is normal and must not trip `set -e`.
            if [ -n "$v" ]; then printf '%s=%s\n' "$k" "$v" >> "$out"; fi
          done
        '';
        base = {
          description = "web service: ${s.displayName}";
          restartIfChanged = false;
          # A unit gets systemd's minimal PATH, so add the system profile where the
          # lazy-tool stubs live.
          path = [ "/run/current-system/sw" "/run/wrappers" ];
          serviceConfig = {
            # The `+` runs the pre-step as root because /proc/1/environ is root-only.
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
    # Boot oneshot that restarts every autostart service after the pod is
    # recreated.
    // {
      scooter-service-restore = {
        description = "restore web services enabled before suspend (from ${stateFile})";
        wantedBy = [ "multi-user.target" ];
        after = [ "workspace.mount" "local-fs.target" ];
        # Waits for the workspace mount when it is a real unit.
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          ExecStart = "${scooterService}/bin/scooter-service restore";
        };
      };
    };

    # Links the discovery manifest into /run at boot.
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
