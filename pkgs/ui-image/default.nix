{ pkgs, lib, n2c, ui, ... }:

# OCI image for the conversation UI: nginx serving the static assistant-ui build
# and reverse-proxying the agent-host API on the same origin.
#
# The browser loads the SPA from /, and its AG-UI client calls relative paths
# (/agui SSE, /sessions, /conversations, /models) — nginx forwards those to the
# agent-host Service. AGENT_HOST_URL is templated in at container start.

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

      server {
        listen 8080;
        root ${ui};
        index index.html;

        # Agent-host API — same-origin reverse proxy.
        location /agui          { proxy_pass ''${AGENT_HOST_URL}; proxy_set_header Host $host; proxy_set_header Connection ""; }
        location /sessions      { proxy_pass ''${AGENT_HOST_URL}; proxy_set_header Host $host; }
        location /conversations { proxy_pass ''${AGENT_HOST_URL}; proxy_set_header Host $host; }
        location /models        { proxy_pass ''${AGENT_HOST_URL}; proxy_set_header Host $host; }

        # SPA: serve the app, fall back to index.html for client routes.
        location / { try_files $uri $uri/ /index.html; }
      }
    }
  '';

  # Entry script: substitute AGENT_HOST_URL into the conf, then exec nginx.
  entrypoint = pkgs.writeShellScript "ui-entrypoint" ''
    set -e
    : "''${AGENT_HOST_URL:=http://agent-host:8080}"
    ${pkgs.gettext}/bin/envsubst '$AGENT_HOST_URL' \
      < ${nginxConfTemplate} > /tmp/nginx.conf
    exec ${pkgs.nginx}/bin/nginx -c /tmp/nginx.conf -g 'daemon off;'
  '';
in
{
  image = n2c.buildImage {
    name = "agent-sandbox-ui";
    tag = "latest";
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
      Env = [ "AGENT_HOST_URL=http://agent-host:8080" ];
      ExposedPorts = { "8080/tcp" = { }; };
    };
  };
}
