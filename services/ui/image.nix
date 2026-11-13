{ pkgs, n2c, ui, contribManifest ? null }:

# OCI image for the conversation UI: nginx serving the static assistant-ui build
# and reverse-proxying the agent-host API and the contribs' broker public paths
# on the same origin. The config (image/nginx.nix) is templated from the env at container start.

let
  # Runtime-writable dirs plus the passwd entries nginx looks up on start.
  nginxDirs = pkgs.runCommand "ui-nginx-dirs" { } ''
    mkdir -p $out/var/log/nginx $out/var/cache/nginx $out/tmp $out/var/run $out/etc
    chmod 1777 $out/tmp
    echo 'root:x:0:0:root:/root:/bin/sh' > $out/etc/passwd
    echo 'nobody:x:65534:65534:nobody:/nonexistent:/bin/false' >> $out/etc/passwd
    echo 'root:x:0:' > $out/etc/group
    echo 'nogroup:x:65534:' >> $out/etc/group
  '';

  nginxConf = import ./image/nginx.nix { inherit pkgs ui contribManifest; };

  # Renders the conf from the env, then execs nginx.
  entrypoint = pkgs.writeShellScript "ui-entrypoint" ''
    set -e
    ${nginxConf.render} /tmp/nginx.conf
    exec ${pkgs.nginx}/bin/nginx -c /tmp/nginx.conf -g 'daemon off;'
  '';
  image = n2c.buildImage {
    name = "agent-sandbox-ui";
    tag = "latest";
    # Keeps nginx and the static build in separate layers.
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
      StopSignal = nginxConf.stopSignal;
      Env = [
        "AGENT_HOST_URL=http://agent-host:8080"
        # Where the contribs' broker public paths are proxied.
        "BROKER_URL=http://agent-broker:8080"
        # Unset means /telemetry/ 204s and discards.
        "OTEL_COLLECTOR_URL="
      ];
      ExposedPorts = { "8080/tcp" = { }; };
    };
  };
in
image
