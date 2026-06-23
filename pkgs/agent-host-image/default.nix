{ pkgs, lib, n2c, agentHost, ... }:

# OCI image for the agent-host. Includes the node app (goose wrapped onto PATH
# via the package) + cacert. It talks to the K8s API in-cluster (provisioner +
# exec) using its mounted ServiceAccount.

{
  image = n2c.buildImage {
    name = "agent-host";
    tag = "latest";
    copyToRoot = pkgs.buildEnv {
      name = "agent-host-root";
      paths = [ agentHost pkgs.cacert pkgs.coreutils pkgs.bashInteractive ];
      pathsToLink = [ "/bin" "/etc/ssl" ];
    };
    config = {
      Entrypoint = [ "${agentHost}/bin/agent-host" ];
      Env = [
        "PORT=8080"
        "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
        "STATE_PATH=/var/lib/agent-host/conversations"
      ];
      ExposedPorts = { "8080/tcp" = { }; };
    };
  };
}
