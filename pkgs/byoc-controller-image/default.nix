{ pkgs, lib, n2c, byocController, ... }:

# OCI image for the BYOC controller (Node service). It holds the bring-your-own-Claude container
# sockets so ANY agent-host replica can drive them — see todo/docs/BYO_CLAUDE_REMOTE_AGENT.md §L.

{
  image = n2c.buildImage {
    name = "byoc-controller";
    tag = "latest";
    copyToRoot = pkgs.buildEnv {
      name = "byoc-controller-root";
      # nodejs is needed at RUNTIME (the bin/ entry is a node script, not a static binary), and
      # cacert so the controller can reach Postgres over TLS where the DSN requires it.
      paths = [ byocController pkgs.nodejs pkgs.cacert ];
      pathsToLink = [ "/bin" "/lib" "/etc/ssl" ];
    };
    config = {
      Entrypoint = [ "${byocController}/bin/byoc-controller" ];
      Env = [ "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt" ];
      ExposedPorts = { "8080/tcp" = { }; };
    };
  };
}
