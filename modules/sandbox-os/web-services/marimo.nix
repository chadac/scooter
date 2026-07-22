# webServices.marimo — a marimo notebook served under /c/<id>/marimo/.
#
# marimo supports sub-path serving: `--base-url /c/<id>/marimo` makes it emit
# prefixed hyperlinks/assets, and `--proxy <host>` makes absolute URLs correct for
# the external host. Both are read from the pod env (CONVERSATION_ID injected by
# the provisioner; PUBLIC_HOST optional) at start, so ExecStart is a shell wrapper.
#
# Packaged lazily: `programs.lazyTools.tools.marimo` puts a `marimo` stub on PATH
# that `nix build <pin>#marimo`s on first start — the base image ships only the
# .drv. Paired with the scooter-web-services skill (marimo-pair) so the agent can
# drive the running notebook.
#
# This module only supplies DEFAULTS (mkDefault) for the marimo service + its
# lazy-tool. They're inert until a deployment/agent sets
# `webServices.marimo.enable = true` — so we must NOT gate on
# `cfg.enable` here (reading the option to define the option is infinite
# recursion). The parent web-services.nix filters on `.enable` when it renders
# units + the manifest, so an un-enabled marimo produces nothing.

{ config, lib, pkgs, ... }:

let
  cfg = config.webServices.marimo;
in
{
  # Lazy-built marimo on PATH (built on first `systemctl start`). Declaring the
  # stub unconditionally is cheap — it bakes only a .drv, no closure.
  programs.lazyTools.tools.marimo = {
    package = lib.mkDefault "marimo";
  };

  webServices.marimo = {
    port = lib.mkDefault 2718;
    displayName = lib.mkDefault "marimo";
    # Run as root (like the agent's own exec'd shell) so notebooks land on the
    # /workspace PVC the agent uses — there's no dedicated sandbox user, and
    # DynamicUser couldn't write the shared workspace.
    user = lib.mkDefault "root";
    workingDirectory = lib.mkDefault "/workspace";
    # `command` is types.str; writeShellScript returns a DERIVATION, so interpolate it
    # to its store-path STRING. (A bare derivation type-checks in the image build's
    # coercion path but FAILS the re-converge eval — where webServices.command is read
    # as a plain string.)
    command = lib.mkDefault "${pkgs.writeShellScript "marimo-web-service" ''
      set -euo pipefail
      base="/c/''${CONVERSATION_ID:-unknown}/marimo"
      proxy_args=()
      if [ -n "''${PUBLIC_HOST:-}" ]; then proxy_args+=(--proxy "''${PUBLIC_HOST}"); fi
      # --no-token: access is gated by the platform proxy (the pod isn't public);
      # marimo-pair also needs a token-less server to attach to.
      exec marimo edit \
        --host 0.0.0.0 --port ${toString cfg.port} \
        --base-url "$base" "''${proxy_args[@]}" \
        --headless --no-token
    ''}";
  };
}
