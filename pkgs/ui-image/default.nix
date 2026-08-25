{ pkgs, lib, n2c, ui, ... }:

# OCI image for the conversation UI: nginx serving the static assistant-ui build
# and reverse-proxying the agent-host API on the same origin.
#
# The browser loads the SPA from /, and its AG-UI client calls relative paths
# (/agui SSE, /sessions, /conversations, /models, /whoami, /scheduled-tasks) —
# nginx forwards those to the agent-host Service. AGENT_HOST_URL is templated in
# at container start. Every agent-host API prefix the UI calls needs a `location`
# here; a missing one falls through to the SPA handler (GET→index.html, write→405).

let
  # nginx needs these dirs writable at runtime + a passwd with the worker user
  # (it getpwnam("nobody")s on start; the minimal image has no /etc/passwd).
  nginxDirs = pkgs.runCommand "ui-nginx-dirs" { } ''
    mkdir -p $out/var/log/nginx $out/var/cache/nginx $out/tmp $out/var/run $out/etc
    chmod 1777 $out/tmp
    echo 'root:x:0:0:root:/root:/bin/sh' > $out/etc/passwd
    echo 'nobody:x:65534:65534:nobody:/nonexistent:/bin/false' >> $out/etc/passwd
    echo 'root:x:0:' > $out/etc/group
    echo 'nogroup:x:65534:' >> $out/etc/group
  '';

  # nginx.conf with a ${AGENT_HOST_URL} placeholder substituted at start.
  nginxConfTemplate = pkgs.writeText "nginx.conf.template" ''
    worker_processes auto;
    error_log /dev/stderr warn;
    pid /var/run/nginx.pid;
    events { worker_connections 1024; }
    http {
      include ${pkgs.nginx}/conf/mime.types;
      default_type application/octet-stream;
      access_log /dev/stdout;
      sendfile on;
      # SSE needs buffering off + long read timeouts (agent runs are slow).
      proxy_http_version 1.1;
      proxy_read_timeout 3600s;
      proxy_buffering off;
      # WebSocket upgrade passthrough for the /c/ web-service proxy (marimo kernel,
      # xterm PTY, vscode RPC): "upgrade" when the client requests it, else "".
      map $http_upgrade $connection_upgrade { default upgrade; "" ""; }

      server {
        listen 8080;
        root ${ui};
        index index.html;

        # Agent-host API — same-origin reverse proxy. /agui and /conversations
        # carry SSE (POST /agui, GET /conversations/:id/events[.integrity]), so
        # they MUST disable buffering and use HTTP/1.1 keep-alive or events would
        # be batched/withheld and the live UI stream would stall.
        location /agui {
          proxy_pass ''${AGENT_HOST_URL};
          proxy_set_header Host $host;
          proxy_http_version 1.1;
          proxy_set_header Connection "";
          proxy_buffering off;
          proxy_read_timeout 3600s;
        }
        location /conversations {
          proxy_pass ''${AGENT_HOST_URL};
          proxy_set_header Host $host;
          proxy_http_version 1.1;
          proxy_set_header Connection "";
          proxy_buffering off;
          proxy_read_timeout 3600s;
        }
        # BROWSER TELEMETRY. The UI posts OTLP/HTTP here; nginx forwards it to the
        # cluster's Alloy collector, which ships traces to Grafana Cloud Tempo.
        #
        # Proxied SAME-ORIGIN rather than sent to the collector directly, because
        # that is what keeps this behind the ingress auth: the browser holds no
        # telemetry credential, and a vendor change (Grafana -> Datadog) is a
        # collector-side config change with no UI rebuild.
        #
        # Buffering ON (unlike /agui): these are small batched POSTs, not a
        # stream. When OTEL_COLLECTOR_URL is unset this returns 204 and discards
        # the payload, so a deployment without a collector is not an error.
        location /telemetry/ {
          proxy_pass ''${OTEL_COLLECTOR_URL}/;
          proxy_set_header Host $host;
          # Telemetry must never delay or break the page: fail fast and stay quiet.
          proxy_connect_timeout 2s;
          proxy_read_timeout 5s;
          proxy_intercept_errors on;
          error_page 500 502 503 504 = @telemetry_sink;
        }
        # Swallow collector failures (and stand in when none is configured) so the
        # browser sees success and does not retry into a hole.
        location @telemetry_sink { return 204; }

        # RUNTIME telemetry config. The UI image is built ONCE and deployed to clusters
        # that may or may not have a collector, so this cannot be a build-time VITE_ flag
        # baked into the bundle. The UI fetches this on load and stays inert unless
        # enabled is true. Must be matched BEFORE `location /telemetry/` above would
        # proxy it to the collector — nginx prefers an exact match, so `= ` does that.
        location = /telemetry/config.json {
          default_type application/json;
          return 200 '{"enabled":''${TELEMETRY_ENABLED},"sampleRatio":''${TELEMETRY_SAMPLE_RATIO}}';
        }

        location /sessions      { proxy_pass ''${AGENT_HOST_URL}; proxy_set_header Host $host; }
        location /models        { proxy_pass ''${AGENT_HOST_URL}; proxy_set_header Host $host; }
        # The caller's identity (used by the UI for the Mine/All filter + the user
        # badge). MUST be proxied — otherwise it falls through to `location /` and
        # returns index.html instead of the JSON, and the badge/filter break. The
        # ingress-injected identity headers (x-auth-* or x-amzn-oidc-*) pass through
        # by default (only Host is overridden).
        location /whoami        { proxy_pass ''${AGENT_HOST_URL}; proxy_set_header Host $host; }
        # Scheduled-tasks CRUD (the Settings page). MUST be proxied — otherwise it
        # falls through to `location /`, where GET returns index.html (200) and any
        # POST/PATCH/DELETE hits the static handler and 405s. (This is the /whoami
        # bug class: an agent-host API path missing a proxy location.)
        location /scheduled-tasks { proxy_pass ''${AGENT_HOST_URL}; proxy_set_header Host $host; }
        # The settings Users page lists learned users (/users); also covers the
        # webhooks reverse lookup (/users/by-email). Same proxy-or-405 rule as above.
        location /users         { proxy_pass ''${AGENT_HOST_URL}; proxy_set_header Host $host; }

        # Bring-your-own-Claude (Increment 2): /remote-agent/status + /remote-agent/join-token are
        # JSON (Settings section), and /remote-agent/connect is a persistent WebSocket the user's
        # container dials in on — so this needs the WS-upgrade headers + no buffering + a long read
        # timeout (like /c/). Same proxy-or-405 rule: without this location, /remote-agent/* falls
        # through to `location /` (SPA HTML on GET, 405 on the POST).
        location /remote-agent {
          proxy_pass ''${AGENT_HOST_URL};
          proxy_set_header Host $host;
          proxy_http_version 1.1;
          proxy_set_header Upgrade $http_upgrade;
          proxy_set_header Connection $connection_upgrade;
          proxy_buffering off;
          proxy_read_timeout 3600s;
        }

        # Web-service reverse proxy: /c/<id>/<service>/... -> the agent-host, which
        # resolves the conversation's pod and forwards to the in-pod service. Needs
        # WebSocket upgrade (marimo kernel / xterm PTY / vscode RPC) and no
        # buffering. The agent-host owns id->pod resolution + the (existing) auth.
        location /c/ {
          proxy_pass ''${AGENT_HOST_URL};
          proxy_set_header Host $host;
          proxy_http_version 1.1;
          proxy_set_header Upgrade $http_upgrade;
          proxy_set_header Connection $connection_upgrade;
          proxy_buffering off;
          proxy_read_timeout 3600s;
        }

        # SPA: serve the app, fall back to index.html for client routes.
        location / { try_files $uri $uri/ /index.html; }
      }
    }
  '';

  # Entry script: substitute AGENT_HOST_URL into the conf, then exec nginx.
  entrypoint = pkgs.writeShellScript "ui-entrypoint" ''
    set -e
    : "''${AGENT_HOST_URL:=http://agent-host:8080}"
    # No collector configured -> point the proxy at a loopback that always fails,
    # which @telemetry_sink turns into a 204. Telemetry is optional by design.
    # Telemetry is ON only when a collector was ACTUALLY configured — otherwise the UI
    # would collect spans and post them into the 204 sink for nothing. Test before the
    # default is applied, since the default is the "no collector" placeholder.
    if [ -n "''${OTEL_COLLECTOR_URL:-}" ]; then TELEMETRY_ENABLED=true; else TELEMETRY_ENABLED=false; fi
    : "''${OTEL_COLLECTOR_URL:=http://127.0.0.1:1}"
    : "''${TELEMETRY_SAMPLE_RATIO:=1}"
    export TELEMETRY_ENABLED TELEMETRY_SAMPLE_RATIO
    ${pkgs.gettext}/bin/envsubst '$AGENT_HOST_URL $OTEL_COLLECTOR_URL $TELEMETRY_ENABLED $TELEMETRY_SAMPLE_RATIO' \
      < ${nginxConfTemplate} > /tmp/nginx.conf
    exec ${pkgs.nginx}/bin/nginx -c /tmp/nginx.conf -g 'daemon off;'
  '';
in
{
  image = n2c.buildImage {
    name = "agent-sandbox-ui";
    tag = "latest";
    # Split nginx (stable) from the static build (changes on every UI edit) so a
    # UI change only re-pushes the small dist layer, not nginx + its deps.
    maxLayers = 25;
    copyToRoot = [
      (pkgs.buildEnv {
        name = "ui-root";
        paths = [ pkgs.nginx pkgs.bashInteractive pkgs.coreutils pkgs.gettext ];
        pathsToLink = [ "/bin" ];
      })
      nginxDirs
    ];
    config = {
      Entrypoint = [ "${entrypoint}" ];
      Env = [
        "AGENT_HOST_URL=http://agent-host:8080"
        # Unset by default: no collector => /telemetry/ 204s and discards.
        "OTEL_COLLECTOR_URL="
      ];
      ExposedPorts = { "8080/tcp" = { }; };
    };
  };
}
