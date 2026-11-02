# files' sandbox half: a read-only viewer over the workspace PVC, served under
# /c/<id>/files/. The viewer runs in the pod, so listing and reading are ordinary
# local filesystem calls and nothing on the control plane grows a file-read
# endpoint. Like every web service the unit is explicit-start, so declaring it
# costs a manifest entry and no running process.
#
# Supplies mkDefault values only and must not gate on `cfg.enable` (infinite
# recursion); web-services.nix filters on `.enable` when it renders units.

{ config, lib, pkgs, ... }:

let
  cfg = config.webServices.files;

  # The server's own tree (server.py and its sibling modules) as one store path.
  viewer = builtins.path { path = ./viewer; name = "scooter-files-viewer"; };

  # The frontend (viewer-ui/), built by Vite with every library bundled, as its
  # own store path so that editing server.py does not rebuild it.
  frontend = pkgs.callPackage ./viewer-ui { };
in
{
  webServices.files = {
    enable = lib.mkDefault true;
    port = lib.mkDefault 7801;
    displayName = lib.mkDefault "Files";
    # Root, like the agent's own exec'd shell, so the viewer sees the /workspace
    # PVC exactly as the agent wrote it.
    user = lib.mkDefault "root";
    workingDirectory = lib.mkDefault "/workspace";

    # stripBasePath stays at its default of false: the viewer is told its own
    # prefix and emits every link under it, so stripping would double-strip.
    #
    # `command` is types.str, so the derivation is interpolated to its store path
    # for the re-converge eval.
    command = lib.mkDefault "${pkgs.writeShellScript "files-web-service" ''
      set -euo pipefail
      # CONVERSATION_ID arrives via the unit's conv.env; this must match the prefix
      # the proxy forwards or every asset 404s.
      export SCOOTER_FILES_BASE="''${SCOOTER_SERVICE_PREFIX-/c/''${CONVERSATION_ID:-unknown}}/files"
      export SCOOTER_FILES_PORT="${toString cfg.port}"
      export SCOOTER_FILES_ROOT="''${SCOOTER_FILES_ROOT:-/workspace}"
      # Without this the root is a "frontend not built" note; /api/health reports
      # which of the two a viewer is serving.
      export SCOOTER_FILES_STATIC="${frontend}"
      # Units inherit no pod env, so read these from PID 1.
      for var in BROKER_URL SCOOTER_SELF_URL SCOOTER_SELF_TOKEN_PATH CONVERSATION_ID CONVERSATION_URL; do
        if [ -z "''${!var:-}" ]; then
          value=$(${pkgs.coreutils}/bin/tr '\0' '\n' < /proc/1/environ \
            | ${pkgs.gnused}/bin/sed -n "s/^$var=//p" | ${pkgs.coreutils}/bin/head -1 || true)
          export "$var=$value"
        fi
      done
      exec ${pkgs.python3}/bin/python3 ${viewer}/server.py
    ''}";
  };
}
