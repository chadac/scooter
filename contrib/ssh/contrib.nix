# ssh's declaration: a per-user SSH key the broker holds. The sandbox's ssh-agent
# forwards to it, so `ssh` and git over ssh:// authenticate as the user in their
# private conversations, and the key never enters a sandbox.
{ ... }:

{
  contribs.ssh = {
    src = ./.;
    sandbox.module = ./sandbox.nix;

    # Its own database (contrib_ssh), so its Atlas history in ./sql is its own.
    db = {
      enable = true;
      tables.ssh_keys = { };
    };

    services.broker = {
      enable = true;
      pythonDeps = ps: [ ps.cryptography ps.aiosqlite ];
      env.SSH_ENABLED = "true";
    };

    skills."scooter-ssh.md" = ./skills/scooter-ssh.md;

    ui.settingsTabs = [{
      label = "SSH key";
      order = 50;
      entry = "ui/SettingsTab.tsx";
      api = true;
    }];
  };
}
