# echo's declaration; it has no ./deployment.nix because it is disabled.
{
  contribs.echo = {
    src = ./.;
    # The fixture for the sandbox surface's disabled-contrib path.
    sandbox.module = ./sandbox.nix;
    # The fixture for skill DIRECTORIES: SKILL.md to the agent, the folder to the sandbox.
    skillDirs.echo-skill.path = ./skills/echo-skill;
    services.broker.enable = true;
    services.webhooks.enable = true;

    # A second consumer of the approval seam, so it can be tested end to end
    # without mocking one integration's cloud APIs.
    approvals = {
      # Deliberately not the defaults, so a test can tell "read from the manifest"
      # apart from "guessed aws's copy".
      blockedTitle = "Only a reviewer can approve an echo request.";
      blockedHint = "You can't approve this echo request — ask a reviewer.";
    };

    # Never ship, since echo's factory returns enabled=true unconditionally.
    enable = false;
  };
}
