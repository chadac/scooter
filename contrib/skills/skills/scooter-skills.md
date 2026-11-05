# Skills in your sandbox (scooter-skills)

You can give yourself a skill by writing `~/.scooter/skills/<name>/SKILL.md`, with
frontmatter `name` and `description` and then markdown, plus any scripts beside it.
No rebuild is needed: the skill is offered from your **next message**.

- **Names.** A deployment or personal skill with the same name wins, and yours is
  left out.
- **Skill sources.** The skills.sh packages and GitHub repos the user adds in
  Settings → Skill sources are installed into the same directory before each
  message. A re-sync replaces only the skills it installed, never one you wrote.
- **Commands.** `scooter-skills list` shows what is installed. `scooter-skills
  status` shows which sources failed and why. `scooter-skills sync --force`
  reinstalls the sources now.
