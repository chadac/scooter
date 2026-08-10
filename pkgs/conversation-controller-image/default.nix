{ pkgs, lib, n2c, conversationController, ... }:

# OCI image for the Conversation CRD controller.

{
  image = n2c.buildImage {
    name = "conversation-controller";
    tag = "latest";
    copyToRoot = pkgs.buildEnv {
      name = "conversation-controller-root";
      paths = [ conversationController pkgs.cacert ];
      pathsToLink = [ "/bin" "/etc/ssl" ];
    };
    config = {
      Entrypoint = [ "${conversationController}/bin/conversation-controller" ];
      Env = [ "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt" ];
    };
  };
}
