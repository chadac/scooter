# marimo's sandbox half: webServices.notebook, the marimo editor served under
# /c/<id>/notebook/ (or /notebook/ on the conversation's own origin) with `--base-url`
# and `--proxy` read from the pod env at start. This conversation is in marimo's own
# sidebar, its Agent panel: notebook/launch.py turns the panel on and loads
# notebook/agent-panel.js, which opens it on this conversation and points its socket
# at agent-host's ACP endpoint (services/agent-host/src/acp/conversationSocket.ts).
# `pkgs.marimo` is a nix-stubs shim (./stubs.nix) that materializes
# on first start, so declaring the service costs a manifest entry and no running
# process. curl and jq are here for marimo-pair's scripts
# (/etc/scooter/skills/marimo-pair), and marimo-open starts a kernel for them
# when no browser has the notebook open.
#
# Supplies mkDefault values only and must not gate on `cfg.enable` (infinite
# recursion); web-services.nix filters on `.enable` when it renders units.

{ config, lib, pkgs, ... }:

let
  cfg = config.webServices.notebook;

  # Printed by `scooter-service start|status notebook`, since the skill's body
  # can drop out of a long session's context. Mirrors scooter-marimo.md.
  hint = ''
    No tab open? `marimo-open nb.py` starts its kernel for marimo-pair.
    Packages: marimo-pair's ctx.packages.add(), never pip, a venv or a pyproject.toml (each notebook has its own environment).
    Settings: ~/.config/marimo/marimo.toml. More in the scooter-marimo skill.
    This conversation is in the notebook's sidebar too (the Agent panel, labelled Claude).
  '';

  # Starts a notebook's kernel with no browser open, so marimo-pair can reach it.
  marimoOpen = pkgs.writers.writePython3Bin "marimo-open" {
    libraries = [ pkgs.python3Packages.websockets ];
    flakeIgnore = [ "E501" ];
  } (lib.replaceStrings [ "@port@" ] [ (toString cfg.port) ] (builtins.readFile ./notebook/marimo_open.py));

  # marimo 0.25 opens a notebook with every cell stale (runtime.auto_instantiate
  # defaults to false). Here a visit is how the user asks for the notebook, often from a
  # bookmark that wakes the sandbox, so it should arrive computed. This is a user-level
  # default: it is written only while marimo has no settings of its own, and anything the
  # user or agent sets afterwards wins.
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
  environment.systemPackages = lib.mkIf cfg.enable [ pkgs.marimo pkgs.curl pkgs.jq marimoOpen ];

  webServices.notebook = {
    enable = lib.mkDefault true;
    port = lib.mkDefault 2718;
    displayName = lib.mkDefault "Notebook";
    hint = lib.mkDefault hint;
    workingDirectory = lib.mkDefault "/workspace";
    environment = lib.mkDefault ({
      # Pin uv to a Nix-provided Python, since a downloaded CPython cannot exec on NixOS.
      UV_PYTHON = "${pkgs.python314}/bin/python3.14";
      UV_PYTHON_DOWNLOADS = "never";
    });

    # `pkgs.uv` is the uv-nix stub (modules/sandbox-os/stubs.nix): each notebook gets a
    # uv-managed venv with patched wheels, so native deps import, and --sandbox makes it
    # self-contained with its inline PEP 723 deps.
    command =
      let runner = "exec ${pkgs.uv}/bin/uv run --with marimo python ${./notebook/launch.py} edit --sandbox"; in
      # `command` is types.str, so the derivation is interpolated to its store path for the re-converge eval.
      lib.mkDefault "${pkgs.writeShellScript "marimo-web-service" ''
        set -euo pipefail
        prefix="''${SCOOTER_SERVICE_PREFIX-/c/''${CONVERSATION_ID:-unknown}}"
        proxy_args=()
        if [ -n "''${PUBLIC_HOST:-}" ]; then proxy_args+=(--proxy "''${PUBLIC_HOST}"); fi
        # The Agent panel's socket, on this page's origin; agent-host serves it, not the pod.
        SCOOTER_MARIMO_HEAD="<script>window.SCOOTER_ACP_PATH=\"$prefix/_scooter/acp\";</script><script>$(${pkgs.coreutils}/bin/cat ${./notebook/agent-panel.js})</script>"
        export SCOOTER_MARIMO_HEAD
        ${seedSettings}
        # --no-token: access is gated by the platform proxy, and marimo-pair needs a token-less server.
        ${runner} \
          --host 0.0.0.0 --port ${toString cfg.port} \
          --base-url "$prefix/notebook" "''${proxy_args[@]}" \
          --headless --no-token
      ''}";
  };
}
