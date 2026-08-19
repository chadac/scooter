{ pkgs, lib, n2c, remoteAgent, ... }:

# OCI image for the bring-your-own-Claude remote agent (published to ghcr; users `docker run` it).
# Bundles the wrapped remote-agent bin (which already has node + the glibc `claude` CLI on PATH),
# CA certs (for the Anthropic + wss TLS), and a minimal shell/coreutils (the SDK's `claude`
# subprocess shells out). Exposes 1717 for the local Claude login server.

{
  image = n2c.buildImage {
    name = "scooter-remote-agent";
    tag = "latest";
    copyToRoot = pkgs.buildEnv {
      name = "remote-agent-root";
      paths = [
        remoteAgent
        pkgs.cacert
        pkgs.bashInteractive
        pkgs.coreutils
        pkgs.git # the agent may clone; harmless if unused
      ];
      pathsToLink = [ "/bin" "/etc/ssl" ];
    };
    config = {
      Entrypoint = [ "${remoteAgent}/bin/scooter-remote-agent" ];
      Env = [
        "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
        # Where Claude Code reads/writes credentials — mounted volume in the one-liner.
        "CLAUDE_CONFIG_DIR=/root/.claude"
        "HOME=/root"
      ];
      # The local Claude login server (127.0.0.1:34579 in the container, published to the host).
      # Port 34579 is in the high ephemeral range Anthropic's OAuth client whitelists for loopback.
      ExposedPorts = { "34579/tcp" = { }; };
    };
  };
}
