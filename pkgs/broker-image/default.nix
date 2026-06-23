{ pkgs, lib, n2c, broker, ... }:

# OCI image for the credential broker. Thin layered image: the broker Python
# app (with its closure) + cacert, entrypoint = the agent-broker binary.

{
  image = n2c.buildImage {
    name = "agent-broker";
    tag = "latest";
    copyToRoot = pkgs.buildEnv {
      name = "broker-root";
      paths = [ broker pkgs.cacert ];
      pathsToLink = [ "/bin" "/etc/ssl" ];
    };
    config = {
      Entrypoint = [ "${broker}/bin/agent-broker" ];
      Env = [
        "PORT=8080"
        "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
      ];
      ExposedPorts = { "8080/tcp" = { }; };
    };
  };
}
