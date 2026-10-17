# marimo's declaration: a notebook served as webServices.marimo, and marimo-pair, the
# skill the agent drives the running notebook with (its scripts run in the sandbox;
# see contrib/README.md, "Contributing skill directories"). Sandbox-only, plus
# skills. `enable` stays opt-in like every other contrib; this repo's own builds turn
# it on in .github/deployment/config.nix.
{
  contribs.marimo = {
    src = ./.;
    sandbox.module = ./sandbox.nix;
    skills."scooter-marimo.md" = ./skills/scooter-marimo.md;
    # Pinned in contrib/skills.lock (`just lock-skills`).
    skillDirs.marimo-pair = {
      source = "github:marimo-team/marimo-pair";
      dir = "skills/marimo-pair";
    };
  };
}
