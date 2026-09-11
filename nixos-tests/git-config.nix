# nixosTest: Nix-declared git config with writable overrides.
#
# Git config in the sandbox is BOTH Nix-declared (reproducible, deployment-controlled)
# AND writable (the agent can change it at runtime). The boot service writes Nix-declared
# defaults only if not already set, so agent overrides persist across restarts.
#
# This test locks down:
#   1. Nix-declared values are written on first boot.
#   2. An agent write overrides the Nix default.
#   3. THE RESTART CASE (the whole point): an agent's value survives a restart (boot
#      service doesn't overwrite existing values).
#   4. credential.helper=broker overrides any extraConfig.credential.helper value.

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-git-config";

  nodes.machine = { ... }: {
    imports = [ sandboxModule ];

    programs.scooterCarryOver = {
      enable = true;
      home = "/workspace";
      git = {
        userName = "Scooter";
        userEmail = "scooter@scooter.local";
        extraConfig = {
          core.pager = "less -R";
          color.ui = "auto";
          # Attempt to set credential.helper (should be overridden to broker).
          credential.helper = "wrong";
        };
      };
    };
  };

  testScript = ''
    machine.wait_for_unit("default.target")
    machine.wait_for_unit("scooter-git-broker.service")

    # Git commands with HOME=/workspace so git reads /workspace/.gitconfig
    def git(cmd):
        return machine.succeed(f"HOME=/workspace git {cmd}")

    # --- 1. Nix-declared values are written on first boot. ------------------
    name = git("config --global user.name").strip()
    assert name == "Scooter", f"expected 'Scooter', got '{name}'"

    email = git("config --global user.email").strip()
    assert email == "scooter@scooter.local", f"expected 'scooter@scooter.local', got '{email}'"

    pager = git("config --global core.pager").strip()
    assert pager == "less -R", f"expected 'less -R', got '{pager}'"

    # --- 2. Agent write overrides the Nix default. --------------------------
    git("config --global user.name 'Agent Override'")
    
    name = git("config --global user.name").strip()
    assert name == "Agent Override", f"expected 'Agent Override', got '{name}'"
    
    # user.email is unchanged (agent only modified user.name).
    email = git("config --global user.email").strip()
    assert email == "scooter@scooter.local", f"email should be unchanged: '{email}'"

    # --- 3. RESTART CASE: agent's value survives restart. -------------------
    # Simulate a restart by re-running the git-broker unit (it's idempotent).
    machine.succeed("systemctl restart scooter-git-broker.service")
    
    # The agent's override should survive (boot service doesn't overwrite existing).
    name = git("config --global user.name").strip()
    assert name == "Agent Override", f"value lost after restart: '{name}'"
    
    # user.email is still the Nix default (not overwritten by restart).
    email = git("config --global user.email").strip()
    assert email == "scooter@scooter.local", f"default lost after restart: '{email}'"

    # --- 4. credential.helper=broker overrides extraConfig. ------------------
    helper = git("config --global credential.helper").strip()
    assert helper == "broker", f"credential.helper should be 'broker', got '{helper}'"
  '';
}
