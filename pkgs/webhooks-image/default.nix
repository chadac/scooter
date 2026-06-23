{ pkgs, lib, n2c, webhooks, ... }:

# OCI image for the webhooks service.

{
  image = n2c.buildImage {
    name = "agent-webhooks";
    tag = "latest";
    copyToRoot = pkgs.buildEnv {
      name = "webhooks-root";
      paths = [ webhooks pkgs.cacert ];
      pathsToLink = [ "/bin" "/etc/ssl" ];
    };
    config = {
      Entrypoint = [ "${webhooks}/bin/agent-webhooks" ];
      Env = [
        "PORT=8080"
        "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
      ];
      ExposedPorts = { "8080/tcp" = { }; };
    };
  };
}
