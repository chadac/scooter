# webServices.vscode — a browser VS Code (code-server) served under /c/<id>/vscode/.
#
# code-server supports sub-path serving: `--server-base-path /c/<id>/vscode` makes it
# emit prefixed asset/API URLs so it works behind the platform reverse proxy (which
# forwards the FULL external path verbatim — see webServiceProxy.ts). The base path is
# built from CONVERSATION_ID (injected by the provisioner) at start, so ExecStart is a
# shell wrapper.
#
# Packaged lazily: modules/sandbox-os/stubs.nix declares `code-server`, so
# `pkgs.code-server` is a nix-stubs shim built on first start — the image ships the
# recipe, not the (large) closure. So an un-enabled vscode adds ~nothing.
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
  # The code-server shim on PATH, so the agent can run it by hand.
  environment.systemPackages = [ pkgs.code-server ];

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
    # code-server has NO --server-base-path (it's a `code serve-web` flag, not a
    # code-server one), so it can't be told the /c/<id>/vscode prefix. Instead the
    # reverse proxy STRIPS that prefix (stripBasePath below) and code-server serves at
    # ROOT — no base-path flag needed.
    command = lib.mkDefault "${pkgs.writeShellScript "vscode-web-service" ''
      set -euo pipefail
      # --auth none: access is gated by the platform proxy (the pod isn't public).
      # --disable-telemetry / --disable-update-check: no phone-home from the sandbox.
      # code-server keeps its own state under $HOME/.local — HOME=/workspace (set by
      # the provisioner) so it persists on the workspace PVC across suspend/resume.
      exec ${pkgs.code-server}/bin/code-server \
        --bind-addr "0.0.0.0:${toString cfg.port}" \
        --auth none \
        --disable-telemetry \
        --disable-update-check \
        /workspace
    ''}";
    # The proxy strips /c/<id>/vscode before forwarding (code-server serves at root).
    stripBasePath = lib.mkDefault true;
  };
}
