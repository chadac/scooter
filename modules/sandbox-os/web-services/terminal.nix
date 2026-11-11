# webServices.terminal: a browser terminal (ttyd + tmux) served under
# /c/<id>/terminal/. ttyd runs `tmux new -A -s main`, so a reconnect reattaches
# the same persistent session, and its `--base-path` is built from
# CONVERSATION_ID at start. `pkgs.ttyd` is a nix-stubs shim built on first
# start. This module only supplies mkDefault values and must not gate on
# `cfg.enable` (infinite recursion); web-services.nix filters on `.enable`.

{ config, lib, pkgs, ... }:

let
  cfg = config.webServices.terminal;
in
{
  # tmux stays unconditional for the agent's own shells; ttyd rides the service.
  environment.systemPackages = [ pkgs.tmux ] ++ lib.optionals cfg.enable [ pkgs.ttyd ];

  webServices.terminal = {
    port = lib.mkDefault 7681;
    displayName = lib.mkDefault "Terminal";
    workingDirectory = lib.mkDefault "/workspace";
    # `command` is types.str, so the derivation is interpolated to its store path for the re-converge eval.
    command = lib.mkDefault "${pkgs.writeShellScript "terminal-web-service" ''
      set -euo pipefail
      base="''${SCOOTER_SERVICE_PREFIX-/c/''${CONVERSATION_ID:-unknown}}/terminal"
      # libwebsockets dlopen()s its evlib_uv plugin at runtime, so its lib dir must be on the search path.
      export LD_LIBRARY_PATH="${pkgs.libwebsockets}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
      # Writable because the proxy gates access; `tmux new -A` reattaches the session across reconnects.
      exec ${pkgs.ttyd}/bin/ttyd \
        --port ${toString cfg.port} \
        --interface 0.0.0.0 \
        --base-path "$base" \
        --writable \
        --terminal-type xterm-256color \
        ${pkgs.tmux}/bin/tmux new -A -s main
    ''}";
  };
}
