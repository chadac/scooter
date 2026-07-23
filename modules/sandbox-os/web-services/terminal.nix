# webServices.terminal — a browser terminal (ttyd + tmux) served under /c/<id>/terminal/.
#
# ttyd serves an xterm.js web terminal over HTTP + WebSocket (the platform proxy forwards
# both — see webServiceProxy.ts). It runs `tmux new -A -s main`, so the shell lives in a
# PERSISTENT tmux session: reconnecting (browser refresh / proxy blip) reattaches the same
# session, and you get tmux windows/panes for multiple terminals. Inspired by hypernix's
# tmux model, minus the per-task socket exposure — here it's just a plain in-pod service.
#
# ttyd's `--base-path /c/<id>/terminal` makes it emit asset/WS URLs under the reverse-proxy
# prefix; the base path is built from CONVERSATION_ID (injected by the provisioner) at
# start, so ExecStart is a shell wrapper. `-W` makes it writable (interactive) — access is
# gated by the platform proxy, same trust model as marimo (--no-token) / vscode (--auth none).
#
# Packaged lazily: `programs.lazyTools.tools.ttyd` puts a `ttyd` stub on PATH that builds on
# first `systemctl start` — the base image ships only the .drv. tmux is small, so it's a
# normal systemPackage (also handy for the agent's own shells). An un-enabled terminal adds
# ~nothing.
#
# DEFAULTS only (mkDefault). Inert until a deployment/agent sets
# `webServices.terminal.enable = true` — do NOT gate on `cfg.enable` here (reading the
# option to define it is infinite recursion); web-services.nix filters on `.enable`.

{ config, lib, pkgs, ... }:

let
  cfg = config.webServices.terminal;
in
{
  # Lazy-built ttyd on PATH (built on first `systemctl start`). ttyd is MULTI-OUTPUT
  # (out + man); `nix build nixpkgs#ttyd` prints the `man` output first, which the lazy
  # stub would then try to exec ("Is a directory", exit 126). Target the `.out` output
  # explicitly so the stub resolves the binary; the command/bin stay `ttyd` (the attr key).
  programs.lazyTools.tools.ttyd = {
    package = lib.mkDefault "ttyd.out";
  };

  # tmux backs the terminal session; keep it always available (small, and useful for the
  # agent's own shells too).
  environment.systemPackages = [ pkgs.tmux ];

  webServices.terminal = {
    port = lib.mkDefault 7681;
    displayName = lib.mkDefault "Terminal";
    # Run as root (like the agent's own exec'd shell) so the shell operates on the
    # /workspace PVC the agent uses; HOME=/workspace is set by the provisioner.
    user = lib.mkDefault "root";
    workingDirectory = lib.mkDefault "/workspace";
    # `command` is types.str; writeShellScript returns a DERIVATION, so interpolate it to
    # its store-path STRING (a bare derivation fails the re-converge eval — see marimo.nix).
    command = lib.mkDefault "${pkgs.writeShellScript "terminal-web-service" ''
      set -euo pipefail
      base="/c/''${CONVERSATION_ID:-unknown}/terminal"
      # ttyd's libwebsockets dlopen()s its event-loop plugin (libwebsockets-evlib_uv.so)
      # at runtime; a systemd unit's minimal env doesn't have the lib dir on the search
      # path, so ttyd dies with "failed to load evlib_uv / context creation failed".
      # Put libwebsockets' lib dir on LD_LIBRARY_PATH so the plugin resolves.
      export LD_LIBRARY_PATH="${pkgs.libwebsockets}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
      # ttyd serves the web terminal under the proxy base path; -W = writable (the proxy
      # gates access). It runs tmux `new -A -s main`: attach the "main" session if it
      # exists, else create it — so the session PERSISTS across reconnects.
      exec ttyd \
        --port ${toString cfg.port} \
        --interface 0.0.0.0 \
        --base-path "$base" \
        --writable \
        --terminal-type xterm-256color \
        ${pkgs.tmux}/bin/tmux new -A -s main
    ''}";
  };
}
