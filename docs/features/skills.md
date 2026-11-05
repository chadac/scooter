# Skills

A **skill** is markdown that teaches the agent something about *your* environment — the repos
you work in, the conventions you hold, the commands that matter. The agent reads a skill when
it decides the skill is relevant, so you write it once instead of repeating yourself every
conversation.

Scooter has two kinds, and they meet in the same place:

| | **Built-in skills** | **Personal skills** |
|---|---|---|
| Who writes them | whoever deploys the platform | any user, in Settings → Skills |
| Where they live | a `ConfigMap`, from `scooter.agent.skills` | the `agent_host` database, per owner |
| Who sees them | everyone on the deployment | only their author's conversations |
| Changing one | edit the ConfigMap (no image rebuild) | edit the form (no redeploy) |

Both are read at the **start of every conversation**, so a change applies to your next
conversation. One already running keeps the set it started with.

## Writing a personal skill

Settings → **Skills** → *New skill*. Three fields:

- **Name** — lowercase letters, digits and dashes. It is the filename the agent sees
  (`acme-conventions`), and you cannot have two with the same name.
- **When to use it** — the single most important field. This is what the agent reads to
  decide the skill applies, so describe the *situation*, not the contents:

    > *Good:* "Conventions for the acme/app repo. Use when working in acme/app or reviewing its PRs."
    >
    > *Less good:* "Notes about acme."

- **Instructions** — the markdown body, loaded once the agent decides to use the skill.

A skill can be **disabled** without deleting it; a disabled skill is never injected.

!!! tip "Ask Scooter to write it"
    Skills are just markdown. Finishing a task and wishing the agent had known something up
    front is the best moment to ask it to draft the skill, then paste it in.

## Replacing a built-in

If you name a personal skill after one of the deployment's, **yours wins** in your own
conversations. The settings page flags it ("replaces a built-in") and the host logs the
shadowed name, because a surprising prompt should be traceable to your copy rather than
silently different from everyone else's.

## Limits

Everything injected becomes part of the agent's prompt, so personal skills are budgeted
per user:

| Limit | Value |
|---|---|
| Per-skill body | 32 KiB |
| Total across your skills | 128 KiB |
| Number of skills | 50 |

Disabled skills count toward the total — a disabled skill is one toggle away from the
prompt, and finding out you are over budget at the moment you enable one is the worst
time to learn it.

## Skills in the sandbox and skill sources

With the `skills` contrib enabled, a conversation also loads the skills in its own
sandbox, at `~/.scooter/skills/<name>/SKILL.md`. You or the agent can write one there,
and it's offered from the next message.

Settings → **Skill sources** installs skill packages there in every conversation of yours:

- **skills.sh**: anything `npx skills add` accepts, such as `vercel-labs/agent-skills`.
- **GitHub repo**: `owner/repo`, optionally with a `/path` and an `@ref`. Every `SKILL.md`
  under it becomes a skill. Private repos work, because the sandbox clones with its own
  git access.

A source can be limited to named skills. A built-in or personal skill with the same name
always wins. In the sandbox, `scooter-skills status` shows any source that failed to install.

## Where they reach the agent

Personal skills travel every path a built-in does, so the agent behaves the same however
the conversation is served:

- **goose** reads `.goosehints`, with every body inlined.
- The **Claude Agent SDK** discovers `.claude/skills/<name>/SKILL.md` and loads a body only
  when the description matches.
- A [bring-your-own-Claude](byoc.md) container cannot read the cluster's filesystem, so the
  skills are sent to it as data and it writes them itself.

## For operators

Personal skills need the `agent_host` database (they live in its `user_skills` table). Without
a database the Skills tab reports itself unavailable and only the deployment's built-ins are
injected — nothing else degrades.

Deployment-wide skills are unchanged and still set in Nix:

```nix
scooter.agent.skills."project-repo.md" = ''
  ---
  name: project-repo
  description: The main repo and how to clone it. Use at the start of any task in this org.
  ---
  The main repo is github.com/example-org/example-app.
'';
```
