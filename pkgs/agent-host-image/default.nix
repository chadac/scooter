{ pkgs, lib, n2c, agentHost, agent, ... }:

# OCI image for the agent-host. Includes the node app (goose wrapped onto PATH
# via the package) + cacert. It talks to the K8s API in-cluster (provisioner +
# exec) using its mounted ServiceAccount.
#
# Layering: the closure is dominated by stable deps — goose-cli (~855MB) and
# nodejs (~254MB) — while the agent-host's own JS is tiny. Without explicit
# layers, a one-line app change repushes the whole ~1.1GB. So we pin the big
# stable deps into their OWN layers (cached + deduped across pushes) and let
# nix2container auto-split the rest with maxLayers, leaving only a thin app
# layer to rebuild/push on a code change.

let
  # goose writes temp files under /tmp (platform_extensions); the minimal nix
  # image has no /tmp, so `goose acp`'s session/new panics. Ship a world-writable
  # /tmp (and /var/tmp) so the agent process has scratch space.
  tmpdirs = pkgs.runCommand "agent-host-tmpdirs" { } ''
    mkdir -p $out/tmp $out/var/tmp
    chmod 1777 $out/tmp $out/var/tmp
  '';

  # Dedicated layers for the big, rarely-changing closures. Pushed once, then
  # reused — an app-only change no longer touches them.
  gooseLayer = n2c.buildLayer { deps = [ agent ]; };       # goose-cli (~855MB)
  nodeLayer = n2c.buildLayer { deps = [ pkgs.nodejs ]; };  # nodejs (~254MB)
in
{
  image = n2c.buildImage {
    name = "agent-host";
    tag = "latest";

    # Pre-built stable layers first; maxLayers auto-splits the remaining closure
    # (cacert, coreutils, the small app) so the app lands in its own thin layer.
    layers = [ gooseLayer nodeLayer ];
    maxLayers = 50;

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
