# webServices.vscode — a browser VS Code (code-server) served under /c/<id>/vscode/.
#
# code-server supports sub-path serving: `--server-base-path /c/<id>/vscode` makes it
# emit prefixed asset/API URLs so it works behind the platform reverse proxy (which
# forwards the FULL external path verbatim — see webServiceProxy.ts). The base path is
# built from CONVERSATION_ID (injected by the provisioner) at start, so ExecStart is a
# shell wrapper.
#
# Packaged lazily: `programs.lazyTools.tools.code-server` puts a `code-server` stub on
# PATH that `nix build <pin>#code-server`s on first `systemctl start` — the base image
# ships only the .drv, not the (large) closure. So an un-enabled vscode adds ~nothing.
#
# This module only supplies DEFAULTS (mkDefault). It's inert until a deployment/agent
# sets `webServices.vscode.enable = true` — so we must NOT gate on `cfg.enable` here
# (reading the option to define the option is infinite recursion). The parent
# web-services.nix filters on `.enable` when it renders units + the manifest.

{ config, lib, pkgs, ... }:

let
  cfg = config.webServices.vscode;
in
{
  # Lazy-built code-server on PATH (built on first `systemctl start`). Declaring the
  # stub unconditionally is cheap — it bakes only a .drv, no closure.
  programs.lazyTools.tools.code-server = {
    package = lib.mkDefault "code-server";
  };

  webServices.vscode = {
    port = lib.mkDefault 8443;
    displayName = lib.mkDefault "VS Code";
    # Run as root (like the agent's own exec'd shell) so the editor operates on the
    # /workspace PVC the agent uses — there's no dedicated sandbox user, and
    # DynamicUser couldn't write the shared workspace.
    user = lib.mkDefault "root";
    workingDirectory = lib.mkDefault "/workspace";
    # `command` is types.str; writeShellScript returns a DERIVATION, so interpolate it
    # to its store-path STRING (a bare derivation fails the re-converge eval — see marimo.nix).
    command = lib.mkDefault "${pkgs.writeShellScript "vscode-web-service" ''
      set -euo pipefail
      base="/c/''${CONVERSATION_ID:-unknown}/vscode"
      # --auth none: access is gated by the platform proxy (the pod isn't public).
      # --disable-telemetry / --disable-update-check: no phone-home from the sandbox.
      # code-server keeps its own state under $HOME/.local — HOME=/workspace (set by
      # the provisioner) so it persists on the workspace PVC across suspend/resume.
      exec code-server \
        --bind-addr "0.0.0.0:${toString cfg.port}" \
        --server-base-path "$base" \
        --auth none \
        --disable-telemetry \
        --disable-update-check \
        /workspace
    ''}";
  };
}
