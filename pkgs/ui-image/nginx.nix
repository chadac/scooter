{ pkgs, ui, contribManifest ? null }:

# The UI's nginx config, shared by the image (image.nix) and its check (check.nix): a
# template with the upstream placeholders, and `render`, which derives them from the env
# and writes the final config to "$1".
#
# Every agent-host API prefix the UI calls needs a `location` here, because a missing
# one falls through to the SPA handler (GET returns index.html, writes 405).

let
  # The image's own manifest, served when the deployment mounts none.
  builtinManifest = if contribManifest == null
    then pkgs.writeText "contrib-manifest.json" "{}"
    else contribManifest;

  # nginx.conf with the upstream placeholders substituted at start.
  confTemplate = pkgs.writeText "nginx.conf.template" ''
    worker_processes auto;
    error_log /dev/stderr warn;
    pid /var/run/nginx.pid;
    events { worker_connections 1024; }
    http {
      include ${pkgs.nginx}/conf/mime.types;
      default_type application/octet-stream;
      access_log /dev/stdout;
      sendfile on;
      # SSE needs buffering off and long read timeouts.
      proxy_http_version 1.1;
      proxy_read_timeout 3600s;
      proxy_buffering off;
      # WebSocket upgrade passthrough for the proxied web services.
      map $http_upgrade $connection_upgrade { default upgrade; "" ""; }

      # CSP frame-ancestors: only /chat/<id>, and only by its own sandbox origin. $request_uri,
      # since the SPA fallback rewrites $uri to /index.html. Why: PR #843.
      map $request_uri $ui_frame_ancestors {
        default "'none'";
        "~^/chat/(?<chat_label>[0-9a-f]{8})[0-9a-f-]*/?(\?.*)?$" "''${CHAT_FRAME_ANCESTORS}";
      }

      # nginx only pools upstream connections from an upstream{} group with
      # `keepalive`.
      upstream agent_host {
        server ''${AGENT_HOST_SERVER};
        keepalive 32;
        keepalive_requests 1000;
        keepalive_timeout 60s;
      }

      server {
        listen 8080;
        root ${ui};
        index index.html;

        # /agui and /conversations carry SSE, so they disable buffering and use
        # HTTP/1.1 keep-alive.
        location /agui {
          proxy_pass ''${AGENT_HOST_PROXY};
          proxy_set_header Host $host;
          proxy_http_version 1.1;
          proxy_set_header Connection "";
          proxy_buffering off;
          proxy_read_timeout 3600s;
        }
        location /conversations {
          proxy_pass ''${AGENT_HOST_PROXY};
          proxy_set_header Host $host;
          proxy_http_version 1.1;
          proxy_set_header Connection "";
          proxy_buffering off;
          proxy_read_timeout 3600s;
        }
        # Browser telemetry, proxied same-origin so it stays behind the ingress
        # auth; with no collector configured it returns 204.
        location /telemetry/ {
          proxy_pass ''${OTEL_COLLECTOR_URL}/;
          proxy_set_header Host $host;
          # Telemetry must never delay the page, so fail fast.
          proxy_connect_timeout 2s;
          proxy_read_timeout 5s;
          proxy_intercept_errors on;
          error_page 500 502 503 504 = @telemetry_sink;
        }
        # Swallows collector failures so the browser does not retry.
        location @telemetry_sink { return 204; }

        # Runtime telemetry config the UI fetches on load; the exact match beats
        # `location /telemetry/`.
        location = /telemetry/config.json {
          default_type application/json;
          return 200 '{"enabled":''${TELEMETRY_ENABLED},"sampleRatio":''${TELEMETRY_SAMPLE_RATIO}}';
        }

        # The enabled contribs' UI metadata, fetched at load; the exact match beats
        # the SPA handler. The file is the deployment's own when it mounts one, else
        # the image's built-in list (render picks).
        location = /contrib/manifest.json {
          default_type application/json;
          alias ''${CONTRIB_MANIFEST};
        }

        # `Connection ""` clears the hop-by-hop `close` so the upstream{} pool can
        # reuse the connection.
        location /sessions      { proxy_pass ''${AGENT_HOST_PROXY}; proxy_set_header Host $host; proxy_set_header Connection ""; }
        location /models        { proxy_pass ''${AGENT_HOST_PROXY}; proxy_set_header Host $host; proxy_set_header Connection ""; }
        # The caller's identity; the ingress-injected identity headers pass through.
        location /whoami        { proxy_pass ''${AGENT_HOST_PROXY}; proxy_set_header Host $host; proxy_set_header Connection ""; }
        # Scheduled-tasks CRUD for the Settings page.
        location /scheduled-tasks { proxy_pass ''${AGENT_HOST_PROXY}; proxy_set_header Host $host; proxy_set_header Connection ""; }
        # Personal-skills CRUD for the Settings page.
        location /user-skills   { proxy_pass ''${AGENT_HOST_PROXY}; proxy_set_header Host $host; proxy_set_header Connection ""; }
        # Contrib settings tabs reach their broker half as the signed-in user; the
        # agent-host maps /contrib-api/<name>/ to the contrib, so new contribs add nothing here.
        location /contrib-api/  { proxy_pass ''${AGENT_HOST_PROXY}; proxy_set_header Host $host; proxy_set_header Connection ""; }
        # The Users page listing and the webhooks reverse lookup (/users/by-email).
        location /users         { proxy_pass ''${AGENT_HOST_PROXY}; proxy_set_header Host $host; proxy_set_header Connection ""; }

        # /remote-agent/connect is a persistent WebSocket the user's container
        # dials, so this needs the upgrade headers and no buffering.
        location /remote-agent {
          proxy_pass ''${AGENT_HOST_PROXY};
          proxy_set_header Host $host;
          proxy_http_version 1.1;
          proxy_set_header Upgrade $http_upgrade;
          proxy_set_header Connection $connection_upgrade;
          proxy_buffering off;
          proxy_read_timeout 3600s;
        }

        # Web-service proxy: /c/<id>/<service>/... goes to the agent-host, which
        # resolves the pod and forwards with WebSocket upgrade.
        location /c/ {
          proxy_pass ''${AGENT_HOST_PROXY};
          proxy_set_header Host $host;
          proxy_http_version 1.1;
          proxy_set_header Upgrade $http_upgrade;
          proxy_set_header Connection $connection_upgrade;
          proxy_buffering off;
          proxy_read_timeout 3600s;
          # Only nginx-generated errors are caught (no proxy_intercept_errors), so
          # an in-pod service's own 5xx body still reaches the client.
          error_page 502 503 504 = @service_retry;
        }

        # A self-retrying 503 page shown while the agent-host is rolling.
        location @service_retry {
          default_type text/html;
          add_header Retry-After 3 always;
          return 503 '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Scooter</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#111;color:#eee}div{text-align:center}p{color:#999}</style></head><body><div><h1>Scooter is updating</h1><p>This service is briefly unavailable while the platform redeploys.<br>Retrying automatically&hellip;</p></div></body></html>';
        }

        # Static shares go to the broker, proxied same-origin so the broker stays
        # cluster-internal; the UUID is the capability and the broker 404s when
        # shares is disabled.
        location /s/ {
          proxy_pass ''${BROKER_URL};
          proxy_set_header Host $host;
          proxy_buffering on;
        }

        # SPA fallback to index.html for client routes.
        location / {
          try_files $uri $uri/ /index.html;
          add_header Content-Security-Policy "frame-ancestors $ui_frame_ancestors" always;
        }
      }
    }
  '';

  # Derives the placeholders from the env and writes the substituted conf to "$1".
  render = pkgs.writeShellScript "ui-nginx-render" ''
    set -e
    : "''${AGENT_HOST_URL:=http://agent-host:8080}"
    # An upstream `server` takes a bare host:port, so split the scheme off.
    agent_host_scheme="''${AGENT_HOST_URL%%://*}"
    agent_host_authority="''${AGENT_HOST_URL#*://}"
    if [ "$agent_host_scheme" = "$AGENT_HOST_URL" ]; then agent_host_scheme=http; fi
    agent_host_authority="''${agent_host_authority%%/*}"
    # An upstream `server` with no port defaults to 80 even for https.
    case "$agent_host_authority" in
      *:[0-9]*) ;;
      *) if [ "$agent_host_scheme" = https ]; then agent_host_authority="$agent_host_authority:443"; else agent_host_authority="$agent_host_authority:80"; fi ;;
    esac
    AGENT_HOST_SERVER="$agent_host_authority"
    AGENT_HOST_PROXY="$agent_host_scheme://agent_host"
    export AGENT_HOST_SERVER AGENT_HOST_PROXY
    # Where nginx forwards /s/.
    : "''${BROKER_URL:=http://agent-broker:8080}"
    # Decide telemetry before the placeholder default below is applied.
    if [ -n "''${OTEL_COLLECTOR_URL:-}" ]; then TELEMETRY_ENABLED=true; else TELEMETRY_ENABLED=false; fi
    # An unreachable loopback so the proxy fails fast into @telemetry_sink.
    : "''${OTEL_COLLECTOR_URL:=http://127.0.0.1:1}"
    : "''${TELEMETRY_SAMPLE_RATIO:=1}"
    export TELEMETRY_ENABLED TELEMETRY_SAMPLE_RATIO OTEL_COLLECTOR_URL BROKER_URL
    # Who may frame /chat/<id>: its own sandbox origin, or the UI's own without a sandbox
    # domain. $chat_label is nginx's capture of the id's first 8 hex characters.
    sandbox_domain="''${SANDBOX_DOMAIN:-}"
    sandbox_domain="''${sandbox_domain%.}"
    if [ -n "$sandbox_domain" ]; then
      CHAT_FRAME_ANCESTORS="''${SANDBOX_SCHEME:-https}://\$chat_label.$sandbox_domain"
    else
      CHAT_FRAME_ANCESTORS="'self'"
    fi
    export CHAT_FRAME_ANCESTORS
    # The deployment's contrib manifest (modules/platform.nix mounts it) wins over the
    # image's, so a contrib the deployment left off shows no settings tab or tool card.
    if [ -f "''${CONTRIB_MANIFEST_FILE:=/etc/scooter-ui/contrib/manifest.json}" ]; then
      CONTRIB_MANIFEST="$CONTRIB_MANIFEST_FILE"
    else
      CONTRIB_MANIFEST=${builtinManifest}
    fi
    export CONTRIB_MANIFEST
    ${pkgs.gettext}/bin/envsubst '$AGENT_HOST_SERVER $AGENT_HOST_PROXY $BROKER_URL $OTEL_COLLECTOR_URL $TELEMETRY_ENABLED $TELEMETRY_SAMPLE_RATIO $CHAT_FRAME_ANCESTORS $CONTRIB_MANIFEST' \
      < ${confTemplate} > "$1"
  '';
in
{
  inherit confTemplate render;
}
