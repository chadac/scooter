# ssh's deployment half: points every sandbox's SSH clients at the broker-backed agent.
{ config, lib, ... }:

{
  config.scooter.sandboxPod.extraEnv = lib.mkIf (config.scooter.broker.enable && config.contribs.ssh.enable) [
    { name = "SSH_AUTH_SOCK"; value = "/run/scooter-ssh-agent/agent.sock"; }
  ];
}
