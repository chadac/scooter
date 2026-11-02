# Customizing skills

A **skill** is a markdown file that teaches the agent something about your environment:
which repos matter, how to run your tests, which conventions reviewers enforce. Scooter
puts the skill set into every conversation when it starts, so you explain something
once instead of in every prompt.

This chapter adds deployment-wide skills to the flake from
[Getting started](../getting-started.md). For the per-user skills people write in the UI,
see [Skills](../features/skills.md).

## Where skills come from

A conversation's skill set is assembled from three sources, in this order (a later
source wins when two use the same filename):

| Source | Set by | Ships when |
|---|---|---|
| **Contrib skills** | each contrib, e.g. `scooter-grafana.md` | that contrib is enabled (`contribs.<name>.enable`) |
| **Deployment skills** | you, in `scooter.agent.skills` | always |
| **Personal skills** | each user, in Settings → Skills | in that user's conversations only |

Two details catch people out:

- **Scooter's platform skills are not included by default.** These are the skills in the
  repo's top-level [`skills/`](https://github.com/chadac-me/scooter/tree/main/skills)
  directory. They teach the agent how to use its sandbox, the broker CLI, web services,
  scheduling and so on. `scooter.agent.skills` starts empty, so you add them yourself
  from `inputs.scooter.lib.scooterSkills` (see below). Almost every deployment wants them.
- **Contrib skills follow the contrib.** Enable `contribs.grafana` and the agent learns
  how to query Grafana. Disable it and that skill goes away too, so the agent is never
  taught to call a route that doesn't exist. Set `scooter.agent.builtinSkills = false`
  to drop every contrib skill and supply them all yourself.

## 1. Include the platform skills

`scooterSkills` comes from the flake input, not from inside the module, so set it in
`flake.nix`, where `inputs` is in scope:

```nix
# flake.nix
perSystem = { system, ... }: {
  packages.default =
    (inputs.scooter.lib.evalPlatform {
      inherit system;
      module = {
        imports = [ ./scooter.nix ];
        scooter.agent.skills = inputs.scooter.lib.scooterSkills;
      };
    }).config.kubernetes.result;
};
```

## 2. Write a skill

Create `skills/our-repos.md` in your deployment repo:

```markdown
---
name: our-repos
description: >-
  The Acme repositories and how to build them. Use at the start of any coding
  task in the acme GitHub org, or when asked which repo something lives in.
---

# Acme repositories

- `github.com/acme/app` is the main product. Build with `just build` and test with
  `just test`. CI runs `just ci`, so run that before you open a PR.
- `github.com/acme/infra` holds the Terraform. Never `apply`; open a PR instead.

Clone over HTTPS. The broker supplies credentials, so no token handling is needed.
```

The frontmatter matters more than anything else in the file:

- **`name`** is the skill's identity. Keep it the same as the filename without `.md`.
- **`description`** is what the agent reads to decide whether the skill applies, so
  describe *when to use it*, not what it contains. "Use when working in acme/app" works.
  "Notes about acme" doesn't. If you leave it out, Scooter falls back to a `triggers:`
  list of keywords, then to the file's first line of prose.

Keep each skill to one topic. A short, specific skill that loads when it's relevant
beats one large file that's always half off-topic.

## 3. Add it to the deployment

Merge your files over the platform set. `//` replaces on a key collision, so a file
named like a built-in skill (for example `scooter-github.md`) replaces it:

```nix
scooter.agent.skills = inputs.scooter.lib.scooterSkills // {
  "our-repos.md" = builtins.readFile ./skills/our-repos.md;
};
```

With more than a couple of files, read the whole directory:

```nix
scooter.agent.skills = inputs.scooter.lib.scooterSkills
  // lib.mapAttrs (name: _: builtins.readFile (./skills + "/${name}"))
       (lib.filterAttrs (n: t: t == "regular" && lib.hasSuffix ".md" n)
         (builtins.readDir ./skills));
```

Here `lib` is `inputs.nixpkgs.lib`.

To drop a single platform skill, remove it from the set:

```nix
scooter.agent.skills = builtins.removeAttrs inputs.scooter.lib.scooterSkills [
  "scooter-scheduling.md"   # this deployment doesn't run the scheduler
];
```

## 4. Deploy and check

```bash
nix build && kubectl apply -f result
```

Skills are rendered into a ConfigMap that the agent-host reads when each conversation
starts, so no image rebuild is needed. A new conversation picks up the change;
conversations already running keep the set they started with.

To check, start a conversation and ask a question the new skill answers.

## Tips

- **Write skills from real failures.** The best time to write one is right after a
  conversation where the agent wasted time finding something out. Ask it to draft the
  skill itself, then review the result.
- **Personal skills are for drafts.** Try a skill as a personal skill in Settings →
  Skills. Once it's proven, move it into the deployment so everyone gets it.
- **Skills are part of the prompt.** Each one costs tokens in every conversation it
  loads into. Prune ones that no longer pull their weight.

Next: [Setting up contribs](contribs.md).
