# skills' declaration: skill sources from Settings, installed into each sandbox.
{
  contribs.skills = {
    src = ./.;
    sandbox.module = ./sandbox.nix;

    # Its own database (contrib_skills), so its Atlas history in ./sql is its own.
    db = {
      enable = true;
      tables.skill_sources = { };
    };

    services.broker = {
      enable = true;
      pythonDeps = ps: [ ps.aiosqlite ];
      env.SKILLS_ENABLED = "true";
    };

    # Installs the owner's sources, then offers ~/.scooter/skills.
    agent.skillProviders.sandbox = {
      command = "scooter-skills provide";
      timeout = 300;
      wait = 20;
      description = "Skills in ~/.scooter/skills, and the sources from Settings.";
    };

    skills."scooter-skills.md" = ./skills/scooter-skills.md;

    ui.settingsTabs = [{
      id = "skills-sources";
      label = "Skill sources";
      order = 42;
      entry = "ui/SettingsTab.tsx";
      api = true;
    }];
  };
}
