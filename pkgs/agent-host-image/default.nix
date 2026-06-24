{ pkgs, lib, n2c, agentHost, ... }:

# OCI image for the agent-host. Includes the node app (goose wrapped onto PATH
# via the package) + cacert. It talks to the K8s API in-cluster (provisioner +
# exec) using its mounted ServiceAccount.

let
  # goose writes temp files under /tmp (platform_extensions); the minimal nix
  # image has no /tmp, so `goose acp`'s session/new panics. Ship a world-writable
  # /tmp (and /var/tmp) so the agent process has scratch space.
  tmpdirs = pkgs.runCommand "agent-host-tmpdirs" { } ''
    mkdir -p $out/tmp $out/var/tmp
    chmod 1777 $out/tmp $out/var/tmp
  '';
in
{
  image = n2c.buildImage {
    name = "agent-host";
    tag = "latest";
    copyToRoot = [
      (pkgs.buildEnv {
        name = "agent-host-root";
        paths = [ agentHost pkgs.cacert pkgs.coreutils pkgs.bashInteractive ];
        pathsToLink = [ "/bin" "/etc/ssl" ];
      })
      tmpdirs
    ];
    config = {
      Entrypoint = [ "${agentHost}/bin/agent-host" ];
      Env = [
        "PORT=8080"
        "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
        "STATE_PATH=/var/lib/agent-host/conversations"
        "TMPDIR=/tmp"
      ];
      ExposedPorts = { "8080/tcp" = { }; };
    };
  };
}
