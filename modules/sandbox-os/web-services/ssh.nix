# webServices.ssh: sshd over a WebSocket at /c/<id>/ssh/, for Tramp, plain ssh,
# rsync and VS Code Remote-SSH. websocat runs `sshd -i` per connection, so sshd
# never listens on a port. Reaching it already took the proxy's auth for this
# conversation, so sshd accepts any client key. Clients connect with a
# ProxyCommand that opens the WebSocket (scooter-mode's `scooter tunnel`).
# Like terminal.nix, it only sets mkDefault values outside the enabled config.

{ config, lib, pkgs, ... }:

let
  cfg = config.webServices.ssh;
  keyDir = "/workspace/.scooter/ssh";

  # Echoes the offered key back as authorized: the proxy is the gate.
  acceptKey = ''
    #!${pkgs.runtimeShell}
    [ "$1" = root ] && printf '%s %s\n' "$2" "$3"
  '';

  sshdConfig = pkgs.writeText "scooter-sshd_config" ''
    HostKey ${keyDir}/ssh_host_ed25519_key
    PidFile none
    PermitRootLogin prohibit-password
    AuthenticationMethods publickey
    AuthorizedKeysFile none
    AuthorizedKeysCommand /etc/scooter/ssh/accept-key %u %t %k
    AuthorizedKeysCommandUser nobody
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    # PAM, because sshd without it refuses root's locked ("!") account.
    UsePAM yes
    PrintMotd no
    PrintLastLog no
    AcceptEnv TERM LANG LC_*
    Subsystem sftp internal-sftp
  '';
in
{
  config = lib.mkMerge [
    {
      webServices.ssh = {
        port = lib.mkDefault 2222;
        displayName = lib.mkDefault "SSH";
        # A WebSocket for ssh clients, nothing to open in a browser.
        visibleInMenu = lib.mkDefault false;
        hint = lib.mkDefault "Connect with a ProxyCommand that opens the WebSocket (scooter-mode's `scooter tunnel`).";
        command = lib.mkDefault "${pkgs.writeShellScript "ssh-web-service" ''
          set -euo pipefail
          # On the PVC, so the host key survives suspend/resume.
          if [ ! -s ${keyDir}/ssh_host_ed25519_key ]; then
            mkdir -p -m 700 ${keyDir}
            ${pkgs.openssh}/bin/ssh-keygen -q -t ed25519 -N "" -f ${keyDir}/ssh_host_ed25519_key
          fi
          # Store paths, not stubs: sshd re-execs itself by absolute path.
          exec ${pkgs.websocat}/bin/websocat --binary --exit-on-eof \
            ws-l:0.0.0.0:${toString cfg.port} \
            exec:${pkgs.openssh}/bin/sshd --exec-args -i -e -f ${sshdConfig}
        ''}";
      };
    }
    (lib.mkIf cfg.enable {
      # A copy, not a store symlink: sshd refuses a group-writable path like /nix/store.
      environment.etc."scooter/ssh/accept-key" = { text = acceptKey; mode = "0755"; };

      # sshd's privilege-separation user, as services.openssh declares it.
      users.users.sshd = { isSystemUser = true; group = "sshd"; description = "SSH privilege separation user"; };
      users.groups.sshd = { };

      security.pam.services.sshd = { };
    })
  ];
}
