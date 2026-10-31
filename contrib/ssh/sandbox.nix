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

  systemd.services.scooter-ssh-agent = {
    description = "ssh-agent backed by the broker's per-user key";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    # The pod env reaches PID 1, not services, so it is read from there.
    script = ''
      env_of() { tr '\0' '\n' < /proc/1/environ | sed -n "s/^$1=//p" | head -1; }
      broker=''${BROKER_URL:-$(env_of BROKER_URL)}
      token=''${BROKER_TOKEN_PATH:-$(env_of BROKER_TOKEN_PATH)}
      exec ${lib.getExe agent} -socket /run/scooter-ssh-agent/agent.sock \
        -broker "$broker" -token "''${token:-/var/run/secrets/broker/token}"
    '';
    serviceConfig = {
      RuntimeDirectory = "scooter-ssh-agent";
      RuntimeDirectoryMode = "0755";
      Restart = "always";
      RestartSec = 1;
    };
  };
}
