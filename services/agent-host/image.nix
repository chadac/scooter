{ pkgs, lib, n2c, imageLayers, agentHost, agent
  # Bakes the unfree claude CLI; off keeps the image lean.
, withClaudeCode ? false
, extraPackages ? [ ]
}:

# OCI image for the agent-host: the node app (with goose on PATH) plus cacert.
# The big stable deps (goose-cli, nodejs) get their own layers so an app change
# only rebuilds and pushes a thin app layer.

let
  # goose writes temp files under /tmp and the minimal nix image has none, so ship
  # a world-writable /tmp and /var/tmp.
  tmpdirs = pkgs.runCommand "agent-host-tmpdirs" { } ''
    mkdir -p $out/tmp $out/var/tmp
    chmod 1777 $out/tmp $out/var/tmp
  '';

  # Dedicated layers for the big, rarely-changing closures.
  gooseLayer = n2c.buildLayer { deps = [ agent ]; };

  # The claude-code CLI's own layer, only when withClaudeCode.
  claudeCode = pkgs.claude-code;
  claudeLayer = n2c.buildLayer { deps = [ claudeCode ]; };
in
n2c.buildImage {
  name = "agent-host";
  tag = "latest";

  # Stable layers first; maxLayers auto-splits the rest so the app lands in its
  # own thin layer.
  layers = [ gooseLayer imageLayers.node ] ++ lib.optional withClaudeCode claudeLayer;
  maxLayers = 50;

  copyToRoot = [
    (pkgs.buildEnv {
      name = "agent-host-root";
      paths = [ agentHost pkgs.cacert pkgs.coreutils pkgs.bashInteractive ]
        ++ lib.optional withClaudeCode claudeCode ++ extraPackages;
      pathsToLink = [ "/bin" "/etc/ssl" ];
    })
    tmpdirs
  ];
  config = {
    Entrypoint = [ "${agentHost}/bin/agent-host" ];
    Env = [
      "PORT=8080"
      "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
      "LOCAL_STATE_PATH=/var/lib/agent-host/conversations"
      "TMPDIR=/tmp"
    ];
    ExposedPorts = { "8080/tcp" = { }; };
  };
}
