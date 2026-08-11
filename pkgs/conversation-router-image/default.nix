{ pkgs, lib, n2c, conversationRouter, ... }:

# OCI image for the conversation router (Go binary).

{
  image = n2c.buildImage {
    name = "conversation-router";
    tag = "latest";
    copyToRoot = pkgs.buildEnv {
      name = "conversation-router-root";
      paths = [ conversationRouter pkgs.cacert ];
      pathsToLink = [ "/bin" "/etc/ssl" ];
    };
    config = {
      Entrypoint = [ "${conversationRouter}/bin/conversation-router" ];
      Env = [ "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt" ];
      ExposedPorts = { "8080/tcp" = { }; };
    };
  };
}
