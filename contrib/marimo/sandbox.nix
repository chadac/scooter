# marimo's sandbox half. The user-facing service is webServices.notebook, "marimo + chat":
# a static page with this conversation beside the notebook. The marimo server it frames
# is webServices.marimo, unlisted (no Services panel entry), started and stopped with
# it, and served under /c/<id>/marimo/ with `--base-url` and `--proxy` read from the
# pod env at start.
# `pkgs.marimo` is a nix-stubs shim (modules/sandbox-os/stubs.nix) that materializes
# on first start, so declaring the service costs a manifest entry and no running
# process. curl and jq are here for marimo-pair's scripts
# (/etc/scooter/skills/marimo-pair).
#
# Supplies mkDefault values only and must not gate on `cfg.enable` (infinite
# recursion); web-services.nix filters on `.enable` when it renders units.

{ config, lib, pkgs, ... }:

let
  cfg = config.webServices.marimo;

  # marimo 0.25 opens a notebook with every cell stale (runtime.auto_instantiate
  # defaults to false). Here a visit is how the user asks for the notebook, often from a
  # bookmark that wakes the sandbox, so it should arrive computed. This is a user-level
  # default: it is written only while marimo has no settings of its own, and anything the
  # user or agent sets afterwards wins.
  # Printed by `scooter-service start|status notebook`, since the skill's body
  # can drop out of a long session's context. Mirrors scooter-marimo.md.
  hint = ''
    Packages: marimo-pair's ctx.packages.add(), never pip, a venv or a pyproject.toml (each notebook has its own environment).
    Settings: ~/.config/marimo/marimo.toml. More in the scooter-marimo skill.
  '';

  defaultSettings = (pkgs.formats.toml { }).generate "marimo-default-settings.toml" {
    runtime.auto_instantiate = true;
  };
  # Every place marimo reads user settings from counts; marimo itself leaves an empty file.
  seedSettings = pkgs.writeShellScript "marimo-seed-settings" ''
    set -eu
    settings="''${XDG_CONFIG_HOME:-$HOME/.config}/marimo/marimo.toml"
    if [ ! -s "$settings" ] && [ ! -s "$HOME/.marimo.toml" ] && [ ! -s .marimo.toml ]; then
      ${pkgs.coreutils}/bin/mkdir -p "$(${pkgs.coreutils}/bin/dirname "$settings")"
      ${pkgs.coreutils}/bin/install -m 644 ${defaultSettings} "$settings"
    fi
  '';
in
{
  # The marimo shim on PATH, so the agent can run it by hand, and what marimo-pair's
  # scripts call: they talk to the running server's HTTP API with curl and jq.
  environment.systemPackages = lib.mkIf cfg.enable [ pkgs.marimo pkgs.curl pkgs.jq ];

  # The relative app URL works on either base path.
  webServices.notebook = {
    enable = lib.mkDefault cfg.enable;
    port = lib.mkDefault 2720;
    displayName = lib.mkDefault "Notebook";
    chatPage = {
      app = lib.mkDefault "../marimo/";
      title = lib.mkDefault "marimo";
      extraScript = lib.mkDefault ./notebook/sync.js;
    };
    hint = lib.mkDefault hint;
    # Starting the page starts the server it frames.
    extraConfig.wants = [ "webservice-marimo.service" ];
  };

  # The marimo server itself: unlisted, so "marimo + chat" is the only way in. It is
  # PartOf the page's unit, so stopping or restarting `notebook` does the same to it.

  webServices.marimo = {
    enable = lib.mkDefault true;
    port = lib.mkDefault 2718;
    displayName = lib.mkDefault "marimo";
    visibleInMenu = lib.mkDefault false;
    extraConfig.partOf = [ "webservice-notebook.service" ];
    # Root, like the agent's own exec'd shell, so notebooks land on the /workspace PVC.
    user = lib.mkDefault "root";
    workingDirectory = lib.mkDefault "/workspace";
    environment = lib.mkDefault ({
      # marimo's settings live in the agent's own ~/.config on the workspace PVC, not in
      # root's home, which a pod rebuild discards. uv's cache stays out of the PVC.
      XDG_CONFIG_HOME = "/workspace/.config";
      # Pin uv to a Nix-provided Python, since a downloaded CPython cannot exec on NixOS.
      UV_PYTHON = "${pkgs.python314}/bin/python3.14";
      UV_PYTHON_DOWNLOADS = "never";
    });

    # `pkgs.uv` is the uv-nix stub (modules/sandbox-os/stubs.nix): each notebook gets a
    # uv-managed venv with patched wheels, so native deps import, and --sandbox makes it
    # self-contained with its inline PEP 723 deps.
    command =
      let runner = "exec ${pkgs.uv}/bin/uv run --with marimo marimo edit --sandbox"; in
      # `command` is types.str, so the derivation is interpolated to its store path for the re-converge eval.
      lib.mkDefault "${pkgs.writeShellScript "marimo-web-service" ''
        set -euo pipefail
        base="''${SCOOTER_SERVICE_PREFIX-/c/''${CONVERSATION_ID:-unknown}}/marimo"
        proxy_args=()
        if [ -n "''${PUBLIC_HOST:-}" ]; then proxy_args+=(--proxy "''${PUBLIC_HOST}"); fi
        ${seedSettings}
        # --no-token: access is gated by the platform proxy, and marimo-pair needs a token-less server.
        ${runner} \
          --host 0.0.0.0 --port ${toString cfg.port} \
          --base-url "$base" "''${proxy_args[@]}" \
          --headless --no-token
      ''}";
  };
}
