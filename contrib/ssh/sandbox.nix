# ssh's sandbox half: an ssh-agent on a fixed socket whose only key is the user's,
# held by the broker. It is inert until the pod sets SSH_AUTH_SOCK (./deployment.nix).
{ lib, pkgs, ... }:

let
  agent = pkgs.buildGoModule {
    pname = "scooter-ssh-agent";
    version = "0.0.0";
    src = lib.cleanSource ./agent;
    vendorHash = null;
    env.CGO_ENABLED = "0";
    meta.mainProgram = "scooter-ssh-agent";
  };
in
{
  environment.systemPackages = [ pkgs.openssh ];

  # The forges' published host keys, so a first git@ clone verifies.
  programs.ssh.knownHosts = {
    "github.com".publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
    "gitlab.com".publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf";
  };

  systemd.services.scooter-ssh-agent = {
    description = "ssh-agent backed by the broker's per-user key";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    # The pod env reaches PID 1, not services, so it is read from there.
    script = ''
      env_of() { tr '\0' '\n' < /proc/1/environ | sed -n "s/^$1=//p" | head -1; }
      broker=''${BROKER_URL:-$(env_of BROKER_URL)}
      token=''${BROKER_TOKEN_PATH:-$(env_of BROKER_TOKEN_PATH)}
      # Without a broker there is no key to serve, so stay inert.
      [ -n "$broker" ] || exit 0
      exec ${lib.getExe agent} -socket /run/scooter-ssh-agent/agent.sock \
        -broker "$broker" -token "''${token:-/var/run/secrets/broker/token}"
    '';
    serviceConfig = {
      RuntimeDirectory = "scooter-ssh-agent";
      RuntimeDirectoryMode = "0755";
      Restart = "on-failure";
      RestartSec = 1;
    };
  };
}
