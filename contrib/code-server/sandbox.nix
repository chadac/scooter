# code-server's sandbox half: a browser VS Code (code-server) served as
# webServices.vscode under /c/<id>/vscode/, with the proxy stripping that prefix
# because code-server has no base-path flag. `pkgs.code-server` is a nix-stubs shim
# (./code-server-bin, declared in modules/sandbox-os/stubs.nix) built on first start.
# When the pod has router self-access (SCOOTER_SELF_URL), VS Code's chat is bridged to
# this conversation through scooter-vscode-ahp (./ahp). Like every web service the unit
# is explicit-start, so declaring it costs a manifest entry and no running process.
#
# Supplies mkDefault values only and must not gate on `cfg.enable` (infinite
# recursion); web-services.nix filters on `.enable` when it renders units.

{ config, lib, pkgs, ... }:

let
  cfg = config.webServices.vscode;
  # Loopback port of the AHP server code-server bridges to.
  ahpPort = 8765;
  # A stub (stubs.nix) where the stub overlay applies; built directly in evals without it (nixosTests).
  vscodeAhp = pkgs.scooter-vscode-ahp or (pkgs.callPackage ./ahp { });
in
{
  # The code-server shim on PATH, so the agent can run it by hand.
  environment.systemPackages = lib.mkIf cfg.enable [ pkgs.code-server ];

  webServices.vscode = {
    enable = lib.mkDefault true;
    port = lib.mkDefault 8443;
    displayName = lib.mkDefault "Code";
    # Root, like the agent's own exec'd shell, so the editor operates on the /workspace PVC.
    user = lib.mkDefault "root";
    workingDirectory = lib.mkDefault "/workspace";
    # `command` is types.str, so the derivation is interpolated to its store path for the re-converge eval.
    command = lib.mkDefault "${pkgs.writeShellScript "vscode-web-service" ''
      set -euo pipefail
      # --auth none because the platform proxy gates access; state lives under HOME=/workspace so it persists across suspend/resume.
      args=(--bind-addr "0.0.0.0:${toString cfg.port}" --auth none --disable-telemetry --disable-update-check)

      # Self-access env is container env on PID 1 only (see web-services.nix conv.env).
      pid1() { tr '\0' '\n' < /proc/1/environ | sed -n "s/^$1=//p" | head -1 || true; }
      self_url=$(pid1 SCOOTER_SELF_URL)
      self_token=$(pid1 SCOOTER_SELF_TOKEN_PATH)
      if [ -z "$self_url" ] || [ -z "''${CONVERSATION_ID:-}" ] || [ ! -r "$self_token" ]; then
        exec ${pkgs.code-server}/bin/code-server "''${args[@]}" /workspace
      fi

      # Bridge VS Code's agent host to this conversation: start the AHP server, wait for the
      # token it mints, and hand that to code-server. Either exiting stops the unit (Restart=on-failure).
      state="''${RUNTIME_DIRECTORY%%:*}/ahp"
      rm -f "$state/bridge-token"
      SCOOTER_SELF_URL="$self_url" SCOOTER_SELF_TOKEN_PATH="$self_token" AHP_STATE_DIR="$state" \
        AHP_SESSIONS_PATH="''${HOME:-/root}/.local/share/code-server/scooter-ahp/sessions.json" \
        AHP_PORT=${toString ahpPort} ${vscodeAhp}/bin/scooter-vscode-ahp &
      # The first start may build the stub from source, so allow minutes.
      for _ in $(seq 1 600); do [ -s "$state/bridge-token" ] && break; sleep 0.5; done
      [ -s "$state/bridge-token" ] || { echo "scooter-vscode-ahp did not start" >&2; exit 1; }
      ${vscodeAhp}/bin/scooter-vscode-ahp ensure-settings "''${HOME:-/root}/.local/share/code-server/User/settings.json" || true
      ${pkgs.code-server}/bin/code-server "''${args[@]}" \
        --vscode-option agent-host-bridge-port=${toString ahpPort} \
        --vscode-option "agent-host-bridge-connection-token=$(cat "$state/bridge-token")" \
        /workspace &
      wait -n
      exit 1
    ''}";
    # The proxy strips /c/<id>/vscode before forwarding, so code-server serves at root.
    stripBasePath = lib.mkDefault true;
  };
}
