{ pkgs, lib, n2c, scheduler, ... }:

# OCI image for the scheduler service.

{
  image = n2c.buildImage {
    name = "agent-scheduler";
    tag = "latest";
    copyToRoot = pkgs.buildEnv {
      name = "scheduler-root";
      paths = [ scheduler pkgs.cacert ];
      pathsToLink = [ "/bin" "/etc/ssl" ];
    };
    config = {
      Entrypoint = [ "${scheduler}/bin/agent-scheduler" ];
      Env = [
        "PORT=8080"
        "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
      ];
      ExposedPorts = { "8080/tcp" = { }; };
    };
  };
}
