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

    # The fixture for contrib settings tabs, with one /contrib-api round-trip. Echo is
    # disabled, so it also covers "a disabled contrib has no tab".
    ui.settingsTabs = [{
      label = "Echo";
      order = 60;
      entry = "ui/SettingsTab.tsx";
      api = true;
    }];

    # The fixture for contrib views: /echo exists only while echo is enabled.
    ui.views.echo = {
      label = "Echo";
      entry = "ui/View.tsx";
    };

    # The fixture for contrib system tasks: `scooter.systemTasks.echo-greet` while echo
    # is enabled, and nothing while it is not.
    systemTasks.greet = {
      entry = "scooter_contrib_echo.tasks:main";
      args = [ "--greeting" "Hello from echo." ];
      every = "1d";
      timeout = "2m";
    };

    # The fixture for skill providers: one skill, rendered as `echo.hello`.
    agent.skillProviders.hello = {
      command = builtins.readFile ./skill-provider.sh;
      description = "A sample skill, for the provider seam's tests.";
    };

    # Never ship, since echo's factory returns enabled=true unconditionally.
    enable = false;
  };
}
